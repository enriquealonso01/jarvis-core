import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { storeJsonCredential } from "./credentials.js";
import { testConnection } from "./conntest.js";
import { sseBroadcast } from "./sse.js";

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export type ActionKind =
  | "provide_api_key"
  | "host_login"
  | "oauth_connect"
  | "pair_channel"
  | "provide_config";

/** Which auth profiles take a pasted key rather than a host CLI login. */
const KEY_PROFILES = new Set([
  "groq",
  "nvidia",
  "google_ai",
  "elevenlabs",
  "github_personal_admin",
  "backup_b2",
  "netcup_scp",
  "composio",
]);

function last4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

/** pending | consumed | expired — derived, never stored, so it cannot drift. */
export function actionState(row: {
  consumed_at: Date | string | null;
  expires_at: Date | string | null;
}): "pending" | "consumed" | "expired" {
  if (row.consumed_at) return "consumed";
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

/**
 * Create the action request that an Issue's "required action" points at, so a
 * blocker is something Enrique can *do* from a link rather than a sentence he
 * has to translate into steps. Idempotent per issue.
 */
export async function ensureActionRequest(
  pool: pg.Pool,
  args: {
    issueId: string;
    kind: ActionKind;
    title: string;
    message: string;
    profileId?: string;
    connectionSlug?: string;
    /** For a credential that belongs to one project rather than the system. */
    projectId?: string | null;
    /** What it is for and what it costs — S16 asks the page to say both. */
    purpose?: string;
    cost?: string;
    /** Defaults to the ADR 004 two hours. */
    ttlHours?: number;
  },
): Promise<{ id: string; token: string | null }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM user_action_requests
     WHERE issue_id = $1 AND consumed_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC LIMIT 1`,
    [args.issueId],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, token: null };

  // One-time token so a link sent over WhatsApp works without a session, and
  // stops working once used. Only the hash is stored.
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO user_action_requests (issue_id, kind, token_hash, expires_at, payload)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
     RETURNING id`,
    [
      args.issueId,
      args.kind,
      tokenHash,
      // ADR 004: 2-hour TTL on the link token. It travels over WhatsApp, so a
      // long-lived one is a standing key to a credential page.
      String(args.ttlHours ?? 2),
      JSON.stringify({
        title: args.title,
        message: args.message,
        profile_id: args.profileId ?? null,
        connection_slug: args.connectionSlug ?? null,
        project_id: args.projectId ?? null,
        purpose: args.purpose ?? null,
        cost: args.cost ?? null,
      }),
    ],
  );
  return { id: r.rows[0].id, token };
}

export function registerActionRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/action-requests", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT a.id, a.kind, a.payload, a.created_at, a.expires_at, a.consumed_at,
              i.id AS issue_id, i.title AS issue_title, i.severity, i.status AS issue_status,
              i.required_action
       FROM user_action_requests a
       LEFT JOIN issues i ON i.id = a.issue_id
       ORDER BY a.created_at DESC LIMIT 100`,
    );
    return {
      action_requests: r.rows.map((row) => ({
        ...row,
        state: actionState(row as { consumed_at: Date | null; expires_at: Date | null }),
      })),
    };
  });

  app.get("/api/action-requests/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const token = (req.query as { t?: string }).t;

    // A valid one-time token stands in for a session; otherwise require login.
    let authorised = false;
    if (token) {
      const hash = crypto.createHash("sha256").update(token).digest();
      const check = await pool.query(
        `SELECT 1 FROM user_action_requests WHERE id = $1 AND token_hash = $2`,
        [id, hash],
      );
      authorised = (check.rowCount ?? 0) > 0;
      if (!authorised) return reply.code(404).send({ error: "not found" });
    } else {
      const user = await requireUser(pool, req, reply);
      if (!user) return;
      authorised = true;
    }

    const r = await pool.query(
      `SELECT a.id, a.kind, a.payload, a.created_at, a.expires_at, a.consumed_at,
              i.id AS issue_id, i.title AS issue_title, i.severity, i.status AS issue_status,
              i.required_action, i.category
       FROM user_action_requests a
       LEFT JOIN issues i ON i.id = a.issue_id
       WHERE a.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    return {
      action_request: {
        ...row,
        state: actionState(row as { consumed_at: Date | null; expires_at: Date | null }),
      },
    };
  });

  /**
   * An expired link offers a fresh one — delivered to WhatsApp, never rendered.
   *
   * S18b: "an expired link offers a re-issue to his WhatsApp rather than
   * refusing. Small, and it is the difference between the credential loop
   * working on the first try and him going to look for a ticket he was never
   * supposed to have to find."
   *
   * THE DELIVERY CHANNEL IS THE AUTHENTICATION. Whoever is holding an expired
   * link is not necessarily him - a two-hour token that has since lapsed may
   * have been forwarded, screenshotted, or left in a browser somebody else
   * uses. Rendering the replacement on the page would hand a fresh two hours to
   * whoever asked; sending it to WhatsApp hands it to the person who owns the
   * number. So this endpoint returns only an acknowledgement, and the suite
   * asserts the new token appears nowhere in the response.
   *
   * It re-issues only for an EXPIRED request. A consumed one is finished - the
   * credential was supplied - and minting a fresh link for it would reopen a
   * closed door.
   */
  app.post("/api/action-requests/:id/reissue", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{
      id: string; issue_id: string | null; kind: string; payload: Record<string, unknown>;
      consumed_at: Date | null; expires_at: Date | null;
    }>(
      `SELECT id, issue_id, kind, payload, consumed_at, expires_at
         FROM user_action_requests WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not found" });

    const state = actionState(row);
    if (state !== "expired") {
      return reply.code(409).send({
        error: state === "consumed"
          ? "that link was already used, and the thing it was for is done"
          : "that link still works — open it rather than asking for another",
        state,
      });
    }
    if (!row.issue_id) {
      return reply.code(409).send({ error: "this request has no issue to re-open" });
    }

    /*
     * A NEW request rather than an extension of the old one. Extending would
     * revive the exact token that has been sitting in whatever place it expired
     * in; a new row means the old token stays dead however many copies of it
     * exist.
     */
    const payload = row.payload ?? {};
    const fresh = await ensureActionRequest(pool, {
      issueId: row.issue_id,
      kind: row.kind as ActionKind,
      title: String(payload.title ?? "Something needs you"),
      message: String(payload.message ?? "A link Jarvis sent you has expired."),
      profileId: typeof payload.profile_id === "string" ? payload.profile_id : undefined,
      connectionSlug: typeof payload.connection_slug === "string" ? payload.connection_slug : undefined,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      purpose: typeof payload.purpose === "string" ? payload.purpose : undefined,
      cost: typeof payload.cost === "string" ? payload.cost : undefined,
    });

    /*
     * Queued through S33's closed list rather than sent directly: `auth_handoff`
     * is already one of the reasons Jarvis may open a conversation, so this
     * inherits the quiet-hours hold and the batching instead of inventing a
     * second way to reach him.
     */
    const { queueUnprompted } = await import("./unprompted.js");
    await queueUnprompted(pool, {
      reason: "auth_handoff",
      subject: String(payload.title ?? "a link you needed has been re-issued"),
      link: fresh.token ? `${ORIGIN}/action/${fresh.id}?t=${fresh.token}` : null,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
    });

    const { audit } = await import("./audit.js");
    await audit(pool, {
      actor: "user",
      action: "action_request.reissued",
      target: id,
      outcome: "allowed",
      reason: `expired link re-issued as ${fresh.id}, delivered over WhatsApp`,
    });

    // Deliberately no token, and not even the new id's link. The acknowledgement
    // is the whole response.
    return reply.send({
      reissued: true,
      delivered: "whatsapp",
      message: "A fresh link is on its way to your WhatsApp. It is not shown here, "
        + "because whoever is holding an expired link is not necessarily you.",
    });
  });

  app.post("/api/action-requests/:id/submit", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { api_key?: string; token?: string };
    const token = body.token ?? (req.query as { t?: string }).t;

    /*
     * N4 is "one WhatsApp with a link, the action page takes a new PAT" — from a
     * phone, with no terminal and no session. The GET already accepted the
     * one-time token and the POST did not, so the page rendered and the form
     * could not be submitted: the whole loop stopped one field short.
     *
     * The token is single-use and two hours old at most (ADR 004), so it is a
     * weaker credential than a session and is treated as one — it authorises
     * this one request and nothing else. Origin is still enforced for a session
     * submit; a token submit comes from a link in a message and has no origin to
     * check against.
     */
    let viaToken = false;
    if (token) {
      const hash = crypto.createHash("sha256").update(token).digest();
      const check = await pool.query(
        `SELECT 1 FROM user_action_requests WHERE id = $1 AND token_hash = $2`,
        [id, hash],
      );
      if (!check.rowCount) return reply.code(404).send({ error: "not found" });
      viaToken = true;
    } else {
      const user = await requireUser(pool, req, reply);
      if (!user) return;
      if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    }

    const r = await pool.query<{
      id: string;
      kind: string;
      payload: { profile_id?: string; connection_slug?: string; project_id?: string };
      issue_id: string | null;
      consumed_at: Date | null;
      expires_at: Date | null;
    }>(
      `SELECT id, kind, payload, issue_id, consumed_at, expires_at
       FROM user_action_requests WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not found" });

    const state = actionState(row);
    if (state !== "pending") {
      // Expired and used links must fail (FULL_LOOPS L16), not quietly succeed.
      // ADR 004: repeated replay is a security signal, not just a stale tab.
      const replays = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
         WHERE action = 'action_request.replay'
           AND metadata->>'action_request_id' = $1
           AND at > now() - interval '1 hour'`,
        [id],
      );
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('user', 'action_request.replay', $1, $2)`,
        [row.kind, JSON.stringify({ action_request_id: id, state })],
      );
      if (Number(replays.rows[0]?.n ?? 0) >= 2) {
        const { raiseIssue } = await import("./notify.js");
        await raiseIssue(pool, {
          category: "security.broker_deny",
          service: "actions",
          title: "[security] an action link is being replayed",
          dedupeKey: `security.replay:${id}`,
          evidence: { action_request_id: id, state, replays_last_hour: Number(replays.rows[0].n) + 1 },
          requiredAction:
            "A consumed or expired action link has been submitted repeatedly. Nothing was accepted. If this was not you, rotate the credential it pointed at.",
          notifyOverride: "ui_only",
        });
      }
      return reply.code(409).send({ error: `action request is ${state}` });
    }

    let fingerprint: string | null = null;
    let tested: { ok: boolean; detail: string } | null = null;
    if (row.kind === "provide_api_key") {
      const profileId = row.payload?.profile_id;
      const projectId = row.payload?.project_id ?? null;
      const apiKey = body.api_key?.trim();
      if (!apiKey) return reply.code(400).send({ error: "api_key required" });

      /*
       * Two shapes of credential arrive here and they are stored differently.
       *
       * A SYSTEM profile (groq, elevenlabs, the GitHub admin token) is one of
       * the named KEY_PROFILES and belongs to Jarvis. A PROJECT credential
       * belongs to one repository — the token that opens that project's pull
       * requests — and must never be filed under a system profile, because the
       * whole reason it exists is that the admin token can reach every
       * repository on the account and this one cannot.
       */
      const slug = row.payload?.connection_slug ?? profileId ?? "";
      if (!slug) return reply.code(400).send({ error: "this request has no target" });
      if (!projectId) {
        if (!profileId) return reply.code(400).send({ error: "this request has no target profile" });
        if (!KEY_PROFILES.has(profileId)) {
          return reply.code(400).send({ error: "this profile is a host login, not an API key" });
        }
      }

      fingerprint = `${slug}:…${last4(apiKey)}`;
      const stored = await storeJsonCredential(pool, {
        kind: "api_key",
        authProfileId: projectId ? null : (profileId ?? null),
        connectionSlug: slug,
        projectId,
        brokerOnly: !projectId && ["github_personal_admin", "backup_b2", "netcup_scp"].includes(profileId ?? ""),
        fingerprint,
        replace: true,
        payload: { api_key: apiKey },
      });
      if (projectId) {
        // The column the pull-request path reads. Storing the credential is only
        // half of it: without this the token exists and the code that needs it
        // still says the project has none.
        await pool.query("UPDATE projects SET github_api_credential_id = $2 WHERE id = $1", [
          projectId,
          stored.credentialId,
        ]);
      }

      /*
       * S16: "submitted to the broker -> CONNECTION TESTED -> ticket closed".
       *
       * The ticket used to close on the strength of a key having been typed. A
       * wrong one therefore resolved the blocker, requeued the parked task, and
       * sent it straight back into the same failure — which looks like the loop
       * working right up until it does not.
       *
       * A failed test leaves the link UNCONSUMED so the same message can be used
       * again with a better key, keeps the issue open, and says what the
       * provider said. The plan asks for "a useful message rather than a stack
       * trace", and "GitHub answered 401" is the useful version.
       */
      const test = await testConnection(pool, slug);
      if (!test.ok) {
        if (row.issue_id) {
          await pool.query(
            `INSERT INTO issue_events (issue_id, body, actor)
             VALUES ($1, $2, 'user')`,
            [row.issue_id, `a key was submitted and rejected: ${test.detail}`],
          );
        }
        await pool.query(
          `INSERT INTO audit_events (actor, action, target, metadata)
           VALUES ('user', 'action_request.rejected', $1, $2)`,
          [row.kind, JSON.stringify({ action_request_id: id, fingerprint, detail: test.detail })],
        );
        sseBroadcast("issue.updated", {});
        return reply.code(422).send({
          error: {
            code: "connection_test_failed",
            message: `That key was stored but it does not work: ${test.detail}. The ticket is still open — try again with a working one.`,
          },
          tested: test,
        });
      }
      tested = test;
    }

    await pool.query(
      `UPDATE user_action_requests SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );

    // Close the blocker and release anything that was parked on it.
    let released = 0;
    if (row.issue_id) {
      await pool.query(
        `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1`,
        [row.issue_id],
      );
      await pool.query(
        `INSERT INTO issue_events (issue_id, body, actor)
         VALUES ($1, 'resolved from the action page', 'user')`,
        [row.issue_id],
      );
      /*
       * Only what was waiting on THIS blocker.
       *
       * This used to requeue every parked task in the database, which resumed
       * work blocked on a different credential, on a disk that is still full, or
       * on a question nobody has answered — and each one then failed again
       * immediately. Gate 4 wants the opposite property: every affected task
       * links to the issue, and reauthenticating resumes all of them and only
       * them.
       */
      const requeue = await pool.query<{ id: string; state: string }>(
        `UPDATE tasks SET state = 'queued', waiting_reason = NULL,
                blocked_by_issue_id = NULL, lease_owner = NULL, lease_until = NULL,
                updated_at = now()
         WHERE blocked_by_issue_id = $1
           AND state IN ('waiting_for_user', 'waiting_for_provider')
         RETURNING id, 'queued' AS state`,
        [row.issue_id],
      );
      released = requeue.rowCount ?? 0;
      for (const t of requeue.rows) {
        await pool.query(
          `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
           VALUES ($1, 'waiting_for_provider', 'queued', 'blocker resolved from the action page', 'user')`,
          [t.id],
        );
      }
    }

    await pool.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('user', 'action_request.submit', $1, $2)`,
      [row.kind, JSON.stringify({ action_request_id: id, fingerprint, released, via: viaToken ? "link" : "session" })],
    );

    sseBroadcast("issue.updated", {});
    sseBroadcast("queue.updated", {});
    return { ok: true, fingerprint, released, tested };
  });
}
