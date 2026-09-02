import crypto from "node:crypto";
import type pg from "pg";

/**
 * The sudo moment (Part V, S12b item 6).
 *
 * "Level 3 requires re-authentication. Approving an always-confirm action asks
 * for the password again, with a short grace window — a few minutes, so a
 * sequence of related approvals does not become theatre."
 *
 * Until now an always-confirm approval needed nothing but a live session: a
 * browser left open on a phone in a pocket could approve `secrets.export`. The
 * cost of fixing that is one password prompt every few minutes, and only for
 * the fourteen actions on the always-confirm list, which are rare by design —
 * "if it starts feeling frequent, something is mis-classified".
 */

/** How long one re-authentication lasts. Long enough for a run of related approvals. */
export const GRACE_MS = Number(process.env.JARVIS_REAUTH_GRACE_MS ?? 5 * 60_000);

/** The per-hour ceiling on Level 3 approvals from one session (Part V, "bounded, not rate-limited"). */
export const LEVEL3_HOURLY_CEILING = Number(process.env.JARVIS_LEVEL3_CEILING ?? 20);

/** Sessions are identified by the hash of their cookie, never by the cookie. */
export function sessionKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Record that the operator proved, just now, that they are still there. */
export async function recordReauth(pool: pg.Pool, session: string): Promise<void> {
  await pool.query("INSERT INTO reauth_events (session_id) VALUES ($1)", [session]);
}

/** Has this session re-authenticated inside the grace window? */
export async function reauthFresh(pool: pg.Pool, session: string): Promise<boolean> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM reauth_events
     WHERE session_id = $1 AND at > now() - make_interval(secs => $2::int / 1000.0)`,
    [session, GRACE_MS],
  );
  return Number(r.rows[0].n) > 0;
}

/**
 * How many Level 3 approvals this session has made in the last hour.
 *
 * Counted from the audit trail rather than from a counter: a counter can drift
 * out of step with what actually happened, and the audit trail is the thing an
 * incident is reconstructed from anyway.
 */
export async function level3ThisHour(pool: pg.Pool, session: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
     WHERE action = 'approval.approve' AND at > now() - interval '1 hour'
       AND metadata->>'session' = $1 AND metadata->>'level' = '3'`,
    [session],
  );
  return Number(r.rows[0].n);
}

/**
 * What an approval is bound to.
 *
 * "Not the action type — the specific action, its arguments, and the state they
 * were computed against, hashed into the approval." Task grants already do this
 * by SHA (S10); approvals in general did not, and *"approve"* clicked against a
 * stale screen is the failure mode that produces the wrong outcome with a
 * complete audit trail saying it was authorised.
 *
 * Sorted keys, so the same request hashes the same way whichever order the
 * caller happened to build it in.
 */
export function bindingSha(args: {
  actionType: string;
  target?: string | null;
  environment?: string | null;
  resourceVersion?: string | null;
  projectId?: string | null;
}): string {
  const canonical = JSON.stringify({
    action_type: args.actionType,
    target: args.target ?? null,
    environment: args.environment ?? null,
    resource_version: args.resourceVersion ?? null,
    project_id: args.projectId ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
