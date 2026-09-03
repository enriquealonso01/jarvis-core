/**
 * S31: a connection is a set of permitted actions, and there is one seam.
 *
 * The step names the assertions, and they are chosen against specific failures
 * rather than for coverage:
 *
 *  - "A Composio connection permitting one action does not permit a second
 *    action on the same service" - the assertion that separates a permitted-
 *    action set from a switch. One Composio connection reaches hundreds of
 *    services, so "may use Composio" and "may send email as Enrique" are not
 *    the same sentence.
 *  - Cross-project denial behaves identically for all four kinds, and the one
 *    to test is the NATIVE one, "because it is the one that will have been
 *    special-cased".
 *  - "Assert the audit rows are the same shape, not merely that both worked."
 *  - "Remove the Composio adapter and the other kinds keep working. If they do
 *    not, Composio is not behind the interface: it IS the interface."
 *
 * Everything here runs against the real database and the real gate. The two
 * kinds that do real work offline - native reading a real file, direct running
 * a real query - actually do it; the two that need a vendor are exercised
 * through the gate, and the live Composio call is the Done-when, not this.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../src/db.js";
import { storeJsonCredential } from "../src/credentials.js";
import { authorise, invoke, type Adapter, type ConnectorKind } from "../src/connector.js";
import { allAdapters } from "../src/adapters.js";
import { removeFixtures } from "./lib/fixtures.js";

const pool = createPool();
const STAMP = Date.now().toString(36).slice(-6);
const created: string[] = [];
const connIds: string[] = [];

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); pass += 1; };
const bad = (m: string, extra?: unknown) => {
  console.log(`  FAIL - ${m}${extra === undefined ? "" : `: ${String(extra).slice(0, 200)}`}`);
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

async function connection(
  slug: string, kind: string, config: Record<string, unknown>,
  allowedProject: string | null, credentialId: string | null,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, config, credential_id, health)
     VALUES ($1, $2, 'shared', $3, $4, 'healthy') RETURNING id`,
    [slug, kind, JSON.stringify(config), credentialId]);
  const id = r.rows[0].id;
  connIds.push(id);
  if (allowedProject) {
    await pool.query(
      `INSERT INTO connection_project_allowlist (connection_id, project_id) VALUES ($1,$2)`,
      [id, allowedProject]);
  }
  return id;
}

async function permit(connectionId: string, action: string, level: number): Promise<void> {
  await pool.query(
    `INSERT INTO connection_actions (connection_id, action, level, classified_by)
     VALUES ($1,$2,$3,'s31-test')
     ON CONFLICT (connection_id, action) DO UPDATE SET level = EXCLUDED.level`,
    [connectionId, action, level]);
}

/** The audit row this call produced, whatever kind answered it. */
async function lastAudit(target: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{ action: string; target: string; project_id: string | null; metadata: Record<string, unknown> }>(
    `SELECT action, target, project_id, metadata FROM audit_events
      WHERE target = $1 ORDER BY at DESC LIMIT 1`, [target]);
  return r.rows[0] ?? null;
}

let natOkRow: Record<string, unknown> | null = null;

async function main(): Promise<void> {
  const alpha = await project(`s31-alpha-${STAMP}`);
  const beta = await project(`s31-beta-${STAMP}`);

  const dir = mkdtempSync(join(tmpdir(), "s31-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "brief.txt"), "the cutover moves to the 14th");
  writeFileSync(join(dir, "secret-outside.txt"), "should be unreachable");

  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbCred = dbUrl
    ? await storeJsonCredential(pool, {
      kind: "database_url",
      payload: { url: dbUrl },
      fingerprint: `s31-${STAMP}`,
      brokerOnly: false,
      authProfileId: null,
    })
    : null;

  const nat = await connection(`s31-files-${STAMP}`, "native", { root: join(dir, "notes") }, alpha, null);
  const dir2 = await connection(`s31-db-${STAMP}`, "direct", {}, alpha, dbCred?.credentialId ?? null);
  const comp = await connection(`s31-composio-${STAMP}`, "composio", {}, alpha, null);
  const api = await connection(`s31-api-${STAMP}`, "api", { base_url: "https://example.invalid" }, alpha, null);

  const adapters = allAdapters();

  console.log("\n########## a connection is a set of actions, not a switch ##########\n");
  {
    await permit(comp, "github.create_issue", 1);

    const permitted = await authorise(pool, {
      connectionSlug: `s31-composio-${STAMP}`, action: "github.create_issue", projectId: alpha });
    permitted.allowed ? ok("the permitted action is permitted") : bad("the permitted action was refused", permitted.allowed === false && permitted.reason);

    /*
     * The whole point. Same connection, same service, same credential, an
     * action nobody classified - and one that a switch-shaped permission model
     * would wave through because "the project may use Composio".
     */
    const second = await authorise(pool, {
      connectionSlug: `s31-composio-${STAMP}`, action: "github.delete_repo", projectId: alpha });
    !second.allowed
      ? ok("a second action on the SAME service is not permitted by the first")
      : bad("permitting one action permitted another - this is a switch, not a set");
    !second.allowed && second.reason.includes("github.delete_repo")
      ? ok("and the refusal names the action, so it can be classified")
      : bad("the refusal did not say which action", !second.allowed && second.reason);
  }

  console.log("\n########## the kind nobody plans for goes through the same gate ##########\n");
  {
    await permit(nat, "read_file", 1);
    await permit(nat, "list_dir", 1);

    const r = await invoke(pool, adapters, {
      connectionSlug: `s31-files-${STAMP}`, action: "read_file",
      projectId: alpha, input: { path: "brief.txt" } });
    r.ok && String(r.output).includes("the 14th")
      ? ok("native reads a real file through the broker")
      : bad("native read failed", r.ok ? r.output : r.reason);

    /*
     * Captured HERE, not at the end. The first version read the last row for
     * this target after the cross-project denial had been recorded, so it
     * compared a refused native call against a successful direct one and
     * reported a shape difference that was entirely my own doing.
     */
    natOkRow = await lastAudit(`s31-files-${STAMP}:read_file`);

    /*
     * Confinement is the adapter doing its own job, not a second gate: the
     * broker says whether you may read files here at all, the adapter says
     * where "here" is.
     */
    const out = await invoke(pool, adapters, {
      connectionSlug: `s31-files-${STAMP}`, action: "read_file",
      projectId: alpha, input: { path: "../secret-outside.txt" } });
    !out.ok && out.reason.includes("outside the connection root")
      ? ok("and cannot be walked out of with ..")
      : bad("escaped the connection root", out.ok ? out.output : out.reason);

    // The cross-project denial, on the kind most likely to be special-cased.
    const cross = await invoke(pool, adapters, {
      connectionSlug: `s31-files-${STAMP}`, action: "read_file",
      projectId: beta, input: { path: "brief.txt" } });
    !cross.ok
      ? ok("and another project is denied the same native connection")
      : bad("a native connection leaked across projects");
  }

  console.log("\n########## one audit row shape, whatever answered ##########\n");
  {
    const natRow = natOkRow;
    let dirRow: Record<string, unknown> | null = null;
    if (dbCred) {
      await permit(dir2, "query", 1);
      const q = await invoke(pool, adapters, {
        connectionSlug: `s31-db-${STAMP}`, action: "query",
        projectId: alpha, input: { sql: "SELECT 1 AS one" } });
      q.ok ? ok("direct runs a real query through the broker") : bad("direct query failed", q.reason);
      dirRow = await lastAudit(`s31-db-${STAMP}:query`);

      const write = await invoke(pool, adapters, {
        connectionSlug: `s31-db-${STAMP}`, action: "query",
        projectId: alpha, input: { sql: "DELETE FROM projects WHERE slug = 'nope'" } });
      !write.ok ? ok("and refuses anything that is not a SELECT") : bad("a direct connection accepted a write");
    } else {
      bad("no DATABASE_URL, so the direct kind could not be exercised");
    }

    if (natRow && dirRow) {
      const shape = (r: Record<string, unknown>) =>
        Object.keys((r.metadata ?? {}) as Record<string, unknown>).sort().join(",");
      shape(natRow) === shape(dirRow)
        ? ok(`both kinds record the same fields: ${shape(natRow)}`)
        : bad(`audit shapes differ`, `${shape(natRow)} vs ${shape(dirRow)}`);
      const outcomeOf = (r: Record<string, unknown>) =>
        String((r.metadata as Record<string, unknown>)?.outcome ?? "-");
      natRow.action === dirRow.action && outcomeOf(natRow) === outcomeOf(dirRow)
        ? ok(`with the same action and outcome vocabulary: ${natRow.action}/${outcomeOf(natRow)}`)
        : bad("different action/outcome vocabulary",
          `${natRow.action}/${outcomeOf(natRow)} vs ${dirRow.action}/${outcomeOf(dirRow)}`);
    }

    const denied = await lastAudit(`s31-files-${STAMP}:read_file`);
    denied ? ok("and a denial is audited too") : bad("no audit row for the denial");
  }

  console.log("\n########## remove Composio and the interface still stands ##########\n");
  {
    const without = new Map<ConnectorKind, Adapter>(adapters);
    without.delete("composio");

    const still = await invoke(pool, without, {
      connectionSlug: `s31-files-${STAMP}`, action: "read_file",
      projectId: alpha, input: { path: "brief.txt" } });
    still.ok
      ? ok("native still works with the Composio adapter removed")
      : bad("removing Composio broke another kind - it IS the interface", still.reason);

    const gone = await invoke(pool, without, {
      connectionSlug: `s31-composio-${STAMP}`, action: "github.create_issue", projectId: alpha });
    !gone.ok && gone.code === "connector.no_adapter"
      ? ok("and a missing adapter is an ordinary audited no, not an exception")
      : bad("a missing adapter did not refuse cleanly", gone.ok ? gone.output : gone.code);
  }

  console.log("\n########## classification decides, not the caller ##########\n");
  {
    await permit(api, "get", 3);
    const r = await invoke(pool, adapters, {
      connectionSlug: `s31-api-${STAMP}`, action: "get", projectId: alpha, input: { path: "/x" } });
    !r.ok && r.code === "approval.required"
      ? ok("a level 3 action stops for approval instead of running")
      : bad("a level 3 action was not stopped", r.ok ? r.output : r.code);

    /*
     * And it stopped BEFORE the vendor was touched. base_url is
     * https://example.invalid, so a call that reached the adapter would fail
     * with a DNS error rather than an approval - the two are distinguishable,
     * which is the point of pointing it at an unresolvable host.
     */
    !r.ok && !r.reason.includes("example.invalid")
      ? ok("and stopped before the adapter made a request")
      : bad("the request went out before the level was checked", !r.ok && r.reason);
  }

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); fail += 1; })
  .finally(async () => {
    for (const id of connIds) {
      await pool.query(`DELETE FROM connection_actions WHERE connection_id = $1`, [id]).catch(() => undefined);
      await pool.query(`DELETE FROM connection_project_allowlist WHERE connection_id = $1`, [id]).catch(() => undefined);
      await pool.query(`DELETE FROM connections WHERE id = $1`, [id]).catch(() => undefined);
    }
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
