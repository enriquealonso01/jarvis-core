/**
 * S31 live: a real Composio call through the broker, and a denied one.
 *
 *   node --import tsx scripts/s31-composio-live.ts
 *
 * Everything else in S31 is proved against fixtures, which is right for a gate
 * - but the step's Done-when is real work through a real Composio connection
 * with cross-project access denied and audited, and no fixture can tell you
 * whether the vendor accepts the credential this system actually holds.
 *
 * Read-only on purpose. `toolkits.list` asks Composio what it offers; it changes
 * nothing, at Composio or here. The point being proved is the path - broker,
 * permitted action, adapter, audit row - not that Jarvis can make a change
 * somewhere expensive on its first attempt.
 *
 * It creates two projects, allowlists the connection to one of them, and takes
 * both away again in a `finally`.
 */
import { createPool } from "../src/db.js";
import { invoke } from "../src/connector.js";
import { allAdapters } from "../src/adapters.js";
import { removeFixtures } from "./lib/fixtures.js";

const pool = createPool();
const STAMP = Date.now().toString(36).slice(-6);
const created: string[] = [];

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); pass += 1; };
const bad = (m: string, extra?: unknown) => {
  console.log(`  FAIL - ${m}${extra === undefined ? "" : `: ${String(extra).slice(0, 220)}`}`);
  fail += 1;
};

async function project(slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,'personal','normal','non_production')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`, [slug]);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

async function main(): Promise<void> {
  const c = await pool.query<{ id: string; scope: string; credential_id: string | null }>(
    `SELECT id, scope, credential_id FROM connections WHERE slug = 'composio'`);
  const conn = c.rows[0];
  if (!conn) { bad("there is no composio connection on this box"); return; }
  conn.credential_id ? ok("the composio connection has a credential") : bad("no credential");

  const mine = await project(`s31live-mine-${STAMP}`);
  const other = await project(`s31live-other-${STAMP}`);

  /*
   * The connection is system-scoped here, and a system-scoped connection is not
   * reachable by a project at all. For this check it is temporarily shared and
   * allowlisted to ONE project - which is also what makes the denial meaningful:
   * both projects are asking the same shared connection, and only one is on the
   * list.
   */
  const priorScope = conn.scope;
  await pool.query(`UPDATE connections SET scope = 'shared' WHERE id = $1`, [conn.id]);
  await pool.query(
    `INSERT INTO connection_project_allowlist (connection_id, project_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [conn.id, mine]);
  /*
   * There are TWO allowlists and the live run found that the hard way: the
   * connection allowlist above, and the auth-profile allowlist that the same
   * gate checks for the profile behind the connection. Missing the second one
   * denied the call with a reason that read like the first.
   */
  const profile = await pool.query<{ auth_profile_id: string | null }>(
    `SELECT auth_profile_id FROM connections WHERE id = $1`, [conn.id]);
  const profileId = profile.rows[0]?.auth_profile_id;
  if (profileId) {
    await pool.query(
      `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
       VALUES ($1,$2,ARRAY['senior_engineer'])
       ON CONFLICT (auth_profile_id, project_id) DO NOTHING`, [profileId, mine]);
  }

  await pool.query(
    `INSERT INTO connection_actions (connection_id, action, level, classified_by)
     VALUES ($1,'toolkits.list',1,'s31-live')
     ON CONFLICT (connection_id, action) DO UPDATE SET level = 1`, [conn.id]);

  try {
    const adapters = allAdapters();

    const r = await invoke(pool, adapters, {
      connectionSlug: "composio", action: "toolkits.list", projectId: mine });
    if (r.ok) {
      ok("a real Composio call completed through the broker");
      const items = (r.output as { items?: unknown[] } | null)?.items;
      Array.isArray(items) && items.length > 0
        ? ok(`and Composio returned real data: ${items.length} apps`)
        : ok("and Composio answered (no items array in the response shape)");
    } else {
      bad("the live Composio call failed", r.reason);
    }

    const denied = await invoke(pool, adapters, {
      connectionSlug: "composio", action: "toolkits.list", projectId: other });
    !denied.ok
      ? ok("the same connection is denied to a project not on its allowlist")
      : bad("cross-project access was NOT denied");

    const unclassified = await invoke(pool, adapters, {
      connectionSlug: "composio", action: "github.delete_repo", projectId: mine });
    !unclassified.ok
      ? ok("and permitting toolkits.list did not permit anything else")
      : bad("an unclassified action ran");

    /*
     * Audited, checked in the database rather than assumed from a return value.
     * A gate that denies without leaving a record is a gate nobody can review.
     */
    const rows = await pool.query<{ action: string; project_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT action, project_id, metadata FROM audit_events
        WHERE metadata->>'tool' LIKE 'connector.%' AND at > now() - interval '5 minutes'
        ORDER BY at DESC LIMIT 10`);
    const allowed = rows.rows.filter((x) => (x.metadata as { outcome?: string }).outcome === "invoked");
    const refused = rows.rows.filter((x) => (x.metadata as { outcome?: string }).outcome !== "invoked");
    allowed.length >= 1 ? ok(`the successful call is audited (${allowed.length} row)`) : bad("no audit row for the call");
    refused.length >= 1 ? ok(`and so are the denials (${refused.length} rows)`) : bad("denials were not audited");
    rows.rows.some((x) => x.project_id === other)
      ? ok("the denial names the project that was refused")
      : bad("the denial did not record which project asked");
  } finally {
    await pool.query(`DELETE FROM connection_actions WHERE connection_id = $1 AND action = 'toolkits.list'`, [conn.id]);
    await pool.query(`DELETE FROM connection_project_allowlist WHERE connection_id = $1 AND project_id = ANY($2::uuid[])`,
      [conn.id, [mine, other]]);
    if (profileId) {
      await pool.query(
        `DELETE FROM auth_profile_allowlists WHERE auth_profile_id = $1 AND project_id = ANY($2::uuid[])`,
        [profileId, [mine, other]]);
    }
    await pool.query(`UPDATE connections SET scope = $2 WHERE id = $1`, [conn.id, priorScope]);
  }

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); fail += 1; })
  .finally(async () => {
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
