/**
 * S32 — the cookie has a lifetime, and revoking a connection ends it.
 *
 * Four plan lines, and every one of them is about the same gap: the broker
 * holds a password, the profile directory holds working access, and only one of
 * them has ever had a lifecycle.
 *
 *   "Revoke a connection, then attempt the site it was for → refused. Assert on
 *    the profile's stored data, not on the broker row: the broker forgetting a
 *    password while the cookie still works is exactly the failure."
 *
 *   "Age a session past its declared maximum → a handoff, not a silent renewal."
 *
 *   "Invalidate a session server-side, then run a task that needs it → parked
 *    and handed off, not retried. Repeated retries here are failed logins
 *    against his real account."
 *
 *   "Project A's cookies and profile unreachable from project B. Assert it; a
 *    success here is an isolation bug that stops other work."
 *
 * So the assertions are on the FILESYSTEM wherever the plan says to assert on
 * the far side. A row reading `revoked` is exactly what a broken revoke also
 * produces, and it is the thing that would be checked by a test written for
 * convenience.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { revokeConnection } from "../src/connections.js";
import {
  clearSessionsForConnection, establishSession, profileDir, sessionFailed,
  sessionForSite, siteDataDir,
} from "../src/browsersession.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s32s-${Math.random().toString(36).slice(2, 7)}`;

const exists = async (p: string) => {
  try { await fs.stat(p); return true; } catch { return false; }
};

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s32-browsers-"));

  const mk = async (s: string) => (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [s])).rows[0].id;
  const a = await mk(SLUG);
  const b = await mk(`${SLUG}-other`);

  await pool.query(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions)
     VALUES ($1,'native','project',$2,'{}'::jsonb,$3)`,
    [SLUG, a, ["read"]]);

  console.log("1. a profile belongs to one project, by construction");
  profileDir(a, root) !== profileDir(b, root)
    ? ok("two projects get two directories")
    : bad("two projects share a profile directory");
  /*
   * The isolation is in the PATH rather than in a check: profileDir takes a
   * project id and nothing else, so there is no argument by which project B
   * could name project A's directory. Asserted by construction and then on
   * disk, because "the function looks right" is not the same as "the bytes are
   * somewhere else".
   */
  await establishSession(pool, { projectId: a, domain: "dash.example.com", connectionSlug: SLUG, root });
  await fs.writeFile(path.join(siteDataDir(a, "dash.example.com", root), "cookies.sqlite"), "SESSION=abc");
  await establishSession(pool, { projectId: b, domain: "dash.example.com", root });
  await fs.writeFile(path.join(siteDataDir(b, "dash.example.com", root), "cookies.sqlite"), "SESSION=zzz");

  const aCookie = path.join(siteDataDir(a, "dash.example.com", root), "cookies.sqlite");
  const bCookie = path.join(siteDataDir(b, "dash.example.com", root), "cookies.sqlite");
  !path.resolve(aCookie).startsWith(path.resolve(profileDir(b, root)))
    ? ok("and project A's cookie is not underneath project B's profile")
    : bad("project A's data is inside project B's profile");

  console.log("");
  console.log("2. a live session is usable");
  const live = await sessionForSite(pool, a, "dash.example.com");
  live.usable ? ok("the session for the site it was made for is usable") : bad(`unusable: ${JSON.stringify(live)}`);
  const elsewhere = await sessionForSite(pool, a, "other.example.com");
  !elsewhere.usable && elsewhere.why === "none"
    ? ok("and a site it was not made for has no session at all")
    : bad("a session was usable for a different site");

  console.log("");
  console.log("3. ageing out is a handoff, not a silent renewal");
  await pool.query(
    `UPDATE browser_sessions SET expires_at = now() - interval '1 day'
      WHERE project_id = $1 AND domain = 'dash.example.com'`, [a]);
  const aged = await sessionForSite(pool, a, "dash.example.com");
  !aged.usable && aged.why === "expired"
    ? ok(`an aged session is not usable: "${aged.reason}"`)
    : bad(`an expired session was still usable: ${JSON.stringify(aged)}`);
  !aged.usable && aged.needsHandoff
    ? ok("and it asks for a person rather than renewing itself")
    : bad("an expired session did not ask for a handoff");
  const stateAfter = (await pool.query<{ state: string }>(
    `SELECT state FROM browser_sessions WHERE project_id = $1 AND domain = 'dash.example.com'`, [a])).rows[0];
  stateAfter?.state === "expired"
    ? ok("the expiry is decided at use, so there is no window where it is good but stale")
    : bad(`the session state is ${stateAfter?.state}`);

  console.log("");
  console.log("4. a failing session is parked, not retried");
  await establishSession(pool, { projectId: a, domain: "dash.example.com", connectionSlug: SLUG, root });
  const parked = await sessionFailed(pool, {
    projectId: a, domain: "dash.example.com", detail: "the site returned a login page",
  });
  parked.parked && parked.handoff.includes("failed logins")
    ? ok("the first failure parks it and asks for a sign-in")
    : bad(`a failure did not park the session: ${JSON.stringify(parked)}`);
  const afterFail = await sessionForSite(pool, a, "dash.example.com");
  !afterFail.usable && afterFail.why === "failed"
    ? ok("and it is not usable again until a person has been")
    : bad("a failed session was still usable");
  /*
   * There is no retry count anywhere in this path, and that is the assertion:
   * a second failure cannot be "the real one", because a design with a
   * threshold is a design that tries again at least once against his account.
   */
  sessionFailed.length === 2
    ? ok("sessionFailed takes no attempt count, so there is no second try to configure")
    : bad("the failure path has grown a retry parameter");

  console.log("");
  console.log("5. revoke, and assert on the profile's stored data");
  await establishSession(pool, { projectId: a, domain: "dash.example.com", connectionSlug: SLUG, root });
  await fs.writeFile(aCookie, "SESSION=abc");
  await exists(aCookie) ? ok("the cookie is on disk before the revoke") : bad("no cookie to revoke");

  const result = await revokeConnection(pool, SLUG, "enrique", root);
  result.sessionsCleared.some((c) => c.domain === "dash.example.com")
    ? ok(`revoke reports clearing the session: ${JSON.stringify(result.sessionsCleared)}`)
    : bad(`revoke cleared nothing: ${JSON.stringify(result)}`);
  /*
   * The assertion the plan asks for, on the far side. A row reading `revoked`
   * is exactly what a revoke that missed the directory also produces.
   */
  !(await exists(aCookie))
    ? ok("and THE COOKIE IS GONE FROM DISK, which is what removing access means")
    : bad("the broker forgot the password and the cookie is still there");
  const refused = await sessionForSite(pool, a, "dash.example.com");
  !refused.usable && refused.why === "revoked"
    ? ok(`attempting the site afterwards is refused: "${refused.reason}"`)
    : bad(`the site was still reachable: ${JSON.stringify(refused)}`);
  !refused.usable && !refused.needsHandoff
    ? ok("without asking him to sign in again, because he is the one who took it away")
    : bad("a revoked session asks for a handoff, as though it were an outage");

  console.log("");
  console.log("6. and it did not reach into the other project");
  await exists(bCookie)
    ? ok("project B's cookie for the same domain is untouched")
    : bad("revoking project A's connection deleted project B's session");
  const bStill = await sessionForSite(pool, b, "dash.example.com");
  bStill.usable
    ? ok("and project B's session still works")
    : bad(`project B lost its session: ${JSON.stringify(bStill)}`);

  console.log("");
  console.log("7. a domain that is not a hostname is not a path");
  let threw = false;
  try {
    siteDataDir(a, "../../../etc", root);
  } catch {
    threw = true;
  }
  threw
    ? ok("a traversal dressed as a domain is refused rather than joined into a path")
    : bad("a domain containing a path separator was turned into a directory");

  await pool.query(`DELETE FROM browser_sessions WHERE project_id = ANY($1::uuid[])`, [[a, b]]);
  await pool.query(`DELETE FROM audit_events WHERE target = $1`, [SLUG]);
  await pool.query(`DELETE FROM connections WHERE project_id = ANY($1::uuid[])`, [[a, b]]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[a, b]]);
  await fs.rm(root, { recursive: true, force: true });

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
