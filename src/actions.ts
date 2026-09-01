import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { storeJsonCredential } from "./credentials.js";
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

  app.post("/api/action-requests/:id/submit", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });

    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { api_key?: string };

    const r = await pool.query<{
      id: string;
      kind: string;
      payload: { profile_id?: string; connection_slug?: string };
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
    if (row.kind === "provide_api_key") {
      const profileId = row.payload?.profile_id;
      const apiKey = body.api_key?.trim();
      if (!profileId) return reply.code(400).send({ error: "this request has no target profile" });
      if (!KEY_PROFILES.has(profileId)) {
        return reply.code(400).send({ error: "this profile is a host login, not an API key" });
      }
      if (!apiKey) return reply.code(400).send({ error: "api_key required" });

      fingerprint = `${profileId}:…${last4(apiKey)}`;
      await storeJsonCredential(pool, {
        kind: "api_key",
        authProfileId: profileId,
        connectionSlug: row.payload?.connection_slug ?? profileId,
        brokerOnly: ["github_personal_admin", "backup_b2", "netcup_scp"].includes(profileId),
        fingerprint,
        replace: true,
        payload: { api_key: apiKey },
      });
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
      const requeue = await pool.query(
        `UPDATE tasks SET state = 'queued', waiting_reason = NULL, updated_at = now()
         WHERE state IN ('waiting_for_user', 'waiting_for_provider')
         RETURNING id`,
      );
      released = requeue.rowCount ?? 0;
      for (const t of requeue.rows as { id: string }[]) {
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
      [row.kind, JSON.stringify({ action_request_id: id, fingerprint, released })],
    );

    sseBroadcast("issue.updated", {});
    sseBroadcast("queue.updated", {});
    return { ok: true, fingerprint, released };
  });
}
