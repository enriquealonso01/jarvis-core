import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { readJsonCredential, storeJsonCredential } from "./credentials.js";

/**
 * The OAuth device code grant, for providers that have no key to paste.
 *
 * Netcup SCP issues refresh tokens exclusively through Keycloak's device flow.
 * The Connections card declared the action as `oauth_connect` and the only code
 * behind it stored a pasted string — so `[setup] netcup_scp OAuth not connected`
 * was a blocker that could not be cleared from the Control Center at all, by
 * anyone, ever.
 *
 * The shape, verified live against the real endpoint:
 *
 *   POST …/realms/scp/protocol/openid-connect/auth/device   client_id=scp
 *     -> { device_code, user_code, verification_uri, verification_uri_complete,
 *          expires_in: 600, interval: 5 }
 *   POST …/realms/scp/protocol/openid-connect/token
 *          grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     -> 400 authorization_pending  … until the human has approved it
 *     -> { refresh_token, access_token }
 *
 * The `device_code` is the server's half and never reaches the browser. What the
 * browser gets is the user code and the URL — the two things that are MEANT to
 * be read out and typed in.
 */

export type DeviceProvider = {
  deviceUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
};

export const DEVICE_PROVIDERS: Record<string, DeviceProvider> = {
  netcup_scp: {
    deviceUrl: "https://www.servercontrolpanel.de/realms/scp/protocol/openid-connect/auth/device",
    tokenUrl: "https://www.servercontrolpanel.de/realms/scp/protocol/openid-connect/token",
    clientId: "scp",
  },
};

/** Test seam: answer from a script instead of the provider. See the suite. */
const FAKE = process.env.JARVIS_DEVICEFLOW === "fake";

type StartResult =
  | {
      ok: true;
      flowId: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string | null;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; error: string };

async function form(url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/** Ask the provider for a code the human can type in. */
export async function startDeviceFlow(pool: pg.Pool, profileId: string): Promise<StartResult> {
  const provider = DEVICE_PROVIDERS[profileId];
  if (!provider) return { ok: false, error: `${profileId} does not use the device flow` };

  const answer = FAKE
    ? {
        status: 200,
        json: {
          device_code: `fake-device-${Date.now().toString(36)}`,
          user_code: "FAKE-CODE",
          verification_uri: "https://example.invalid/device",
          verification_uri_complete: "https://example.invalid/device?user_code=FAKE-CODE",
          expires_in: 600,
          interval: 1,
        } as Record<string, unknown>,
      }
    : await form(provider.deviceUrl, {
        client_id: provider.clientId,
        ...(provider.scope ? { scope: provider.scope } : {}),
      }).catch((err: unknown) => ({ status: 0, json: { error: String(err) } as Record<string, unknown> }));

  const j = answer.json;
  if (answer.status !== 200 || !j.device_code || !j.user_code) {
    return { ok: false, error: `the provider refused to start a device flow (${answer.status})` };
  }

  // One live flow per profile: a second "Connect" click must not leave the first
  // code valid and confusing.
  await pool.query(
    `UPDATE oauth_device_flows SET state = 'expired', detail = 'superseded by a newer attempt'
     WHERE auth_profile_id = $1 AND state = 'pending'`,
    [profileId],
  );

  const expiresIn = Number(j.expires_in ?? 600);
  const interval = Number(j.interval ?? 5);
  const row = await pool.query<{ id: string }>(
    `INSERT INTO oauth_device_flows
       (auth_profile_id, device_code, user_code, verification_uri, verification_uri_complete,
        interval_seconds, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7::int))
     RETURNING id`,
    [
      profileId,
      String(j.device_code),
      String(j.user_code),
      String(j.verification_uri ?? ""),
      j.verification_uri_complete ? String(j.verification_uri_complete) : null,
      interval,
      expiresIn,
    ],
  );

  return {
    ok: true,
    flowId: row.rows[0].id,
    userCode: String(j.user_code),
    verificationUri: String(j.verification_uri ?? ""),
    verificationUriComplete: j.verification_uri_complete ? String(j.verification_uri_complete) : null,
    expiresIn,
    interval,
  };
}

export type PollResult =
  | { state: "pending"; interval: number }
  | { state: "connected"; fingerprint: string }
  | { state: "expired" | "denied" | "failed"; detail: string };

/**
 * Ask whether the human has approved it yet.
 *
 * `authorization_pending` is the normal answer and is not an error; `slow_down`
 * means poll less often and is also not an error. Everything else ends the flow,
 * because a device code that has been refused is not going to be accepted later.
 */
export async function pollDeviceFlow(pool: pg.Pool, flowId: string): Promise<PollResult> {
  const r = await pool.query<{
    auth_profile_id: string; device_code: string; interval_seconds: number;
    state: string; expired: boolean;
  }>(
    `SELECT auth_profile_id, device_code, interval_seconds, state, (expires_at < now()) AS expired
     FROM oauth_device_flows WHERE id = $1`,
    [flowId],
  );
  const flow = r.rows[0];
  if (!flow) return { state: "failed", detail: "no such device flow" };
  if (flow.state === "connected") return { state: "connected", fingerprint: "already connected" };
  if (flow.state !== "pending") return { state: flow.state as "expired", detail: "this flow has ended" };
  if (flow.expired) {
    await close(pool, flowId, "expired", "the code timed out before it was approved");
    return { state: "expired", detail: "the code timed out before it was approved" };
  }

  const provider = DEVICE_PROVIDERS[flow.auth_profile_id];
  if (!provider) return { state: "failed", detail: "unknown provider" };

  const answer = FAKE
    ? fakePoll(flow.device_code)
    : await form(provider.tokenUrl, {
        client_id: provider.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: flow.device_code,
      }).catch((err: unknown) => ({ status: 0, json: { error: String(err) } as Record<string, unknown> }));

  await pool.query("UPDATE oauth_device_flows SET last_polled_at = now() WHERE id = $1", [flowId]);

  const j = answer.json;
  if (answer.status === 200 && j.refresh_token) {
    /*
     * Stored broker-only. The whole point of the broker is that a credential
     * like this is never handed to a worker or returned to a browser — the
     * console learns that it worked and nothing else.
     */
    const stored = await storeJsonCredential(pool, {
      kind: "oauth",
      authProfileId: flow.auth_profile_id,
      connectionSlug: flow.auth_profile_id,
      brokerOnly: true,
      fingerprint: `${flow.auth_profile_id}:…${String(j.refresh_token).slice(-4)}`,
      replace: true,
      payload: {
        refresh_token: String(j.refresh_token),
        ...(j.access_token ? { access_token: String(j.access_token) } : {}),
        obtained_at: new Date().toISOString(),
      },
    });
    await close(pool, flowId, "connected", "approved");
    await pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE dedupe_key = $1 AND status NOT IN ('resolved','ignored')`,
      [`setup.oauth.${flow.auth_profile_id}`],
    );
    await pool.query(
      "UPDATE auth_profiles SET health = 'healthy' WHERE id = $1",
      [flow.auth_profile_id],
    ).catch(() => undefined);
    return { state: "connected", fingerprint: stored.fingerprint };
  }

  const error = String(j.error ?? "");
  if (error === "authorization_pending") return { state: "pending", interval: flow.interval_seconds };
  if (error === "slow_down") {
    await pool.query(
      "UPDATE oauth_device_flows SET interval_seconds = interval_seconds + 5 WHERE id = $1",
      [flowId],
    );
    return { state: "pending", interval: flow.interval_seconds + 5 };
  }
  if (error === "access_denied") {
    await close(pool, flowId, "denied", "you declined it in the browser");
    return { state: "denied", detail: "you declined it in the browser" };
  }
  if (error === "expired_token") {
    await close(pool, flowId, "expired", "the code timed out before it was approved");
    return { state: "expired", detail: "the code timed out before it was approved" };
  }
  const detail = `${answer.status}: ${error || JSON.stringify(j).slice(0, 160)}`;
  await close(pool, flowId, "failed", detail);
  return { state: "failed", detail };
}

async function close(pool: pg.Pool, flowId: string, state: string, detail: string): Promise<void> {
  await pool.query(
    "UPDATE oauth_device_flows SET state = $2, detail = $3, device_code = '' WHERE id = $1",
    [flowId, state, detail.slice(0, 300)],
  );
}

/** Scripted answers for the suite: pending twice, then approved. */
const fakePolls = new Map<string, number>();
function fakePoll(deviceCode: string): { status: number; json: Record<string, unknown> } {
  if (process.env.JARVIS_DEVICEFLOW_RESULT === "denied") {
    return { status: 400, json: { error: "access_denied" } };
  }
  if (process.env.JARVIS_DEVICEFLOW_RESULT === "expired") {
    return { status: 400, json: { error: "expired_token" } };
  }
  const n = (fakePolls.get(deviceCode) ?? 0) + 1;
  fakePolls.set(deviceCode, n);
  const approveAt = Number(process.env.JARVIS_DEVICEFLOW_APPROVE_AT ?? 3);
  if (n < approveAt) return { status: 400, json: { error: n === 1 ? "authorization_pending" : "slow_down" } };
  return {
    status: 200,
    json: { refresh_token: `fake-refresh-${deviceCode.slice(-6)}`, access_token: "fake-access" },
  };
}

/**
 * Use the refresh token, so it does not die of neglect.
 *
 * Netcup's refresh token expires if it goes unused for about thirty days, which
 * would take Health from green to broken with nothing having changed. Exercising
 * it swaps it for a fresh one on the same schedule as everything else the
 * maintenance pass does.
 */
export async function exerciseRefreshToken(
  pool: pg.Pool,
  profileId: string,
): Promise<{ ok: boolean; detail: string }> {
  const provider = DEVICE_PROVIDERS[profileId];
  if (!provider) return { ok: false, detail: "not a device-flow provider" };
  const cred = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = $1",
    [profileId],
  );
  const id = cred.rows[0]?.credential_id;
  if (!id) return { ok: false, detail: "not connected" };

  const payload = await readJsonCredential(pool, id).catch(() => null);
  const refresh = payload?.refresh_token;
  if (!refresh) return { ok: false, detail: "no refresh token stored" };

  if (FAKE) return { ok: true, detail: "exercised (fake)" };

  // One exchange, one place that writes the rotation back.
  const token = await netcupAccessToken(pool);
  return token.ok ? { ok: true, detail: "refreshed" } : { ok: false, detail: token.detail };
}

/**
 * An access token for netcup, refreshing — and PERSISTING — as it goes.
 *
 * Netcup issues a NEW refresh token on every refresh. Using the stored one
 * without writing back the replacement works exactly once, and then the
 * connection dies quietly with nothing having visibly changed. So there is one
 * function that ever exchanges anything, and it always writes back.
 */
export async function netcupAccessToken(
  pool: pg.Pool,
): Promise<{ ok: true; accessToken: string } | { ok: false; detail: string }> {
  const provider = DEVICE_PROVIDERS.netcup_scp;
  const cred = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'netcup_scp'",
  );
  const id = cred.rows[0]?.credential_id;
  if (!id) return { ok: false, detail: "netcup is not connected" };
  const payload = await readJsonCredential(pool, id).catch(() => null);
  const refresh = payload?.refresh_token;
  if (!refresh) return { ok: false, detail: "no refresh token stored" };

  if (FAKE) return { ok: true, accessToken: "fake-access-token" };

  const answer = await form(provider.tokenUrl, {
    client_id: provider.clientId,
    grant_type: "refresh_token",
    refresh_token: String(refresh),
  }).catch((err: unknown) => ({ status: 0, json: { error: String(err) } as Record<string, unknown> }));

  if (answer.status !== 200 || !answer.json.access_token) {
    await pool
      .query("UPDATE auth_profiles SET health = 'degraded' WHERE id = 'netcup_scp'")
      .catch(() => undefined);
    return { ok: false, detail: `netcup refused the refresh (${answer.status})` };
  }

  /*
   * Write the rotation back BEFORE returning the access token. If this throws,
   * the caller must not go on to use a token whose refresh half has already
   * been spent — that is how a working connection becomes a dead one with no
   * event to point at.
   */
  if (answer.json.refresh_token && String(answer.json.refresh_token) !== String(refresh)) {
    await storeJsonCredential(pool, {
      kind: "oauth",
      authProfileId: "netcup_scp",
      connectionSlug: "netcup_scp",
      brokerOnly: true,
      fingerprint: `netcup_scp:…${String(answer.json.refresh_token).slice(-4)}`,
      replace: true,
      payload: {
        refresh_token: String(answer.json.refresh_token),
        access_token: String(answer.json.access_token),
        obtained_at: new Date().toISOString(),
        rotated: "true",
      },
    });
  }
  await pool
    .query("UPDATE auth_profiles SET health = 'healthy' WHERE id = 'netcup_scp'")
    .catch(() => undefined);
  return { ok: true, accessToken: String(answer.json.access_token) };
}

export function registerDeviceFlowRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const ALLOWED_ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";
  const originOk = (req: { headers: { origin?: string; referer?: string } }) => {
    const origin = req.headers.origin;
    if (origin) return origin === ALLOWED_ORIGIN;
    const referer = req.headers.referer;
    if (referer) return referer.startsWith(`${ALLOWED_ORIGIN}/`);
    return true;
  };

  app.post("/api/auth-profiles/:id/device-flow", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const started = await startDeviceFlow(pool, id);
    if (!started.ok) return reply.code(400).send({ error: started.error });
    // Deliberately no device_code in this response.
    return {
      flow_id: started.flowId,
      user_code: started.userCode,
      verification_uri: started.verificationUri,
      verification_uri_complete: started.verificationUriComplete,
      expires_in: started.expiresIn,
      interval: started.interval,
    };
  });

  app.post("/api/device-flows/:flowId/poll", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const flowId = (req.params as { flowId: string }).flowId;
    return await pollDeviceFlow(pool, flowId);
  });
}
