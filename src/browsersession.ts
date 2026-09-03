/**
 * The lifetime of a cookie (plan S32).
 *
 * The section this implements is the one that is easy to read past:
 *
 *   "The rule above is right — a session Jarvis did not obtain through the
 *    broker is a credential outside the system. **But a session it obtained
 *    properly is also a credential the broker cannot revoke.** He signs in
 *    through the S16 handoff, the site sets a cookie, and from then on the
 *    broker holds a password while the profile directory holds working access.
 *    Those are two different things with two different lifetimes, and only one
 *    of them has a lifecycle."
 *
 * Three consequences, and each one is a rule here rather than a convention:
 *
 *  - **Revoking a connection clears its browser session.** Otherwise "I have
 *    removed Jarvis's access" is false in the way that matters: the password is
 *    gone and the cookie still works. Deleting the profile's data for that site
 *    IS the revocation; the row is bookkeeping. So `clearSessionsForConnection`
 *    removes the files first and the row second, and reports what it deleted -
 *    a revoke that updated a row and missed the directory would otherwise look
 *    identical to one that worked.
 *
 *  - **Sessions age out.** A profile holding a login for six months is access
 *    nobody re-consented to. Expiry produces a HANDOFF, never a silent renewal,
 *    because a renewal nobody was asked about is the standing access the ageing
 *    was meant to prevent.
 *
 *  - **A session that starts failing is treated as revoked, not as flaky.** He
 *    changed his password, or the site invalidated it, and nothing tells
 *    Jarvis. Retrying looks exactly like a transient error and produces
 *    repeated failed logins against his real account - which is worse than the
 *    task failing, because it is his account that gets locked. So the first
 *    failure parks it. There is no retry count in this file, deliberately.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { BROWSERS_DIR } from "./paths.js";

export type SessionState = "live" | "expired" | "failed" | "revoked";

/**
 * Where one project's browser data lives, and nowhere else.
 *
 * "Project-scoped browser profiles at /var/lib/jarvis/browsers/<project_id>,
 * never shared. Cookies, local storage, and saved logins belong to one project
 * and are invisible to every other."
 *
 * The project id is the only input. There is no argument here that could name
 * another project's directory, which is what makes cross-project invisibility a
 * property of the path rather than a check somebody has to remember to run.
 */
export function profileDir(projectId: string, root = BROWSERS_DIR): string {
  return path.join(root, projectId);
}

/** One site's stored data inside that profile. */
export function siteDataDir(projectId: string, domain: string, root = BROWSERS_DIR): string {
  // The domain is used as a directory name, so it has to be one. A hostname
  // cannot contain a separator; anything that does is not a hostname and is not
  // going to be turned into a path here.
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error(`${domain} is not a hostname`);
  return path.join(profileDir(projectId, root), "sites", domain);
}

export type SessionVerdict =
  | { usable: true; sessionId: string; domain: string }
  | { usable: false; why: "none" | "expired" | "failed" | "revoked"; reason: string; needsHandoff: boolean };

/**
 * Can this project use a session for this site right now?
 *
 * Every unusable answer says whether a person has to do something, because the
 * three unusable states are not the same request: `none` and `expired` and
 * `failed` all end in a handoff, and `revoked` ends in "he took this away, do
 * not ask him for it again as though it were an outage".
 */
export async function sessionForSite(
  pool: pg.Pool,
  projectId: string,
  domain: string,
  now = new Date(),
): Promise<SessionVerdict> {
  const r = await pool.query<{
    id: string; state: SessionState; expires_at: string | null; state_reason: string | null;
  }>(
    `SELECT id, state, expires_at::text, state_reason
       FROM browser_sessions WHERE project_id = $1 AND domain = $2`,
    [projectId, domain],
  );
  const s = r.rows[0];
  if (!s) {
    return {
      usable: false, why: "none", needsHandoff: true,
      reason: `there is no session for ${domain} in this project`,
    };
  }
  if (s.state === "revoked") {
    return {
      usable: false, why: "revoked", needsHandoff: false,
      reason: s.state_reason ?? `access to ${domain} was revoked`,
    };
  }
  if (s.state === "failed") {
    return {
      usable: false, why: "failed", needsHandoff: true,
      reason: s.state_reason ?? `the session for ${domain} stopped working`,
    };
  }
  /*
   * Expiry is decided HERE rather than by a sweep, so a session cannot be used
   * in the window between passing its expiry and something noticing. A
   * background job that marks sessions expired every hour is a session that is
   * good for up to an hour past the moment it should have stopped.
   */
  if (s.expires_at && new Date(s.expires_at) <= now) {
    await pool.query(
      `UPDATE browser_sessions SET state = 'expired', state_reason = $2 WHERE id = $1`,
      [s.id, `it passed its declared maximum age on ${s.expires_at}`]);
    return {
      usable: false, why: "expired", needsHandoff: true,
      reason: `the session for ${domain} aged out on ${s.expires_at}, and renewing it without asking would be access nobody re-consented to`,
    };
  }
  return { usable: true, sessionId: s.id, domain };
}

export async function establishSession(
  pool: pg.Pool,
  args: {
    projectId: string; domain: string; connectionSlug?: string | null;
    /** Declared by the connection. Null means it never ages out, which is a choice. */
    maxAgeDays?: number | null;
    root?: string;
  },
): Promise<string> {
  const dir = siteDataDir(args.projectId, args.domain, args.root ?? BROWSERS_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const expires = args.maxAgeDays && args.maxAgeDays > 0
    ? new Date(Date.now() + args.maxAgeDays * 86_400_000)
    : null;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO browser_sessions (project_id, domain, connection_slug, expires_at, last_ok_at, state)
     VALUES ($1,$2,$3,$4, now(), 'live')
     ON CONFLICT (project_id, domain) DO UPDATE
       SET connection_slug = EXCLUDED.connection_slug,
           expires_at = EXCLUDED.expires_at,
           established_at = now(), last_ok_at = now(),
           state = 'live', state_reason = NULL
     RETURNING id`,
    [args.projectId, args.domain, args.connectionSlug ?? null, expires],
  );
  return r.rows[0].id;
}

/**
 * It stopped working. Park it; do not try again.
 *
 * The plan is unusually specific about why: "Repeated retries here are failed
 * logins against his real account." So this takes no attempt count and offers
 * no way to say "the second failure is the real one" - the first one parks it,
 * and a person is asked.
 */
export async function sessionFailed(
  pool: pg.Pool,
  args: { projectId: string; domain: string; detail: string },
): Promise<{ parked: boolean; handoff: string }> {
  await pool.query(
    `UPDATE browser_sessions SET state = 'failed', state_reason = $3
      WHERE project_id = $1 AND domain = $2`,
    [args.projectId, args.domain, args.detail]);
  return {
    parked: true,
    handoff: `Sign in to ${args.domain} again for this project. Jarvis stopped rather than retrying: `
      + "a session that fails looks the same whether the password changed or the site "
      + "invalidated it, and retrying either one is failed logins against your account.",
  };
}

/**
 * Revoking a connection clears the browser sessions it paid for.
 *
 * "Deleting the profile's data for that site IS the revocation; the broker row
 * is bookkeeping." So the directory goes first: if the delete fails, the row
 * must NOT read as revoked, because a row saying revoked over a working cookie
 * is the exact false reassurance this exists to prevent.
 */
export async function clearSessionsForConnection(
  pool: pg.Pool,
  connectionSlug: string,
  root = BROWSERS_DIR,
): Promise<{ cleared: { projectId: string; domain: string }[]; failed: string[] }> {
  const rows = await pool.query<{ id: string; project_id: string; domain: string }>(
    `SELECT id, project_id, domain FROM browser_sessions
      WHERE connection_slug = $1 AND state <> 'revoked'`,
    [connectionSlug]);

  const cleared: { projectId: string; domain: string }[] = [];
  const failed: string[] = [];
  for (const row of rows.rows) {
    try {
      await fs.rm(siteDataDir(row.project_id, row.domain, root), { recursive: true, force: true });
    } catch (err) {
      failed.push(`${row.domain}: ${err instanceof Error ? err.message : "could not be removed"}`);
      continue;
    }
    await pool.query(
      `UPDATE browser_sessions SET state = 'revoked', state_reason = $2 WHERE id = $1`,
      [row.id, `the ${connectionSlug} connection was revoked, and its stored session was deleted`]);
    cleared.push({ projectId: row.project_id, domain: row.domain });
  }
  return { cleared, failed };
}
