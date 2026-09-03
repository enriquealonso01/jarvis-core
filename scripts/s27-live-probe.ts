/**
 * S27, live on the box: "versioning, provenance and audit are the same
 * statement as the write", and a rollback never mutates history.
 *
 * The offline suite proves this architecturally by reading src/. This proves
 * it against the running database, on a throwaway project, including the
 * config.change audit row - a path that had never once been exercised on the
 * box, because auditConfigChange landed on 2026-09-02 and the only three
 * config_versions rows up there predate it.
 */
import { createPool } from "../src/db.js";
import { applyConfigChange, rollbackConfig } from "../src/config.js";

const pool = createPool();
const PROJECT = "8dbd98ef-530f-40ea-83a9-64655d56842f"; // jarvis-e2e-gbbqkr, throwaway
const KEY = "schedule:tester-s27-probe";
let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass++; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}\n        expected: ${String(e)}\n        actual:   ${String(a).slice(0,200)}`); fail++;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));

async function main() {
  await pool.query("DELETE FROM config_versions WHERE key = $1", [KEY]);
  const before = await pool.query<{ n: string }>(
    "SELECT count(*) n FROM audit_events WHERE action = 'config.change'");

  console.log("\n=== a write produces a version, with provenance ===");
  const r1: any = await applyConfigChange(pool, {
    scope: "project", projectId: PROJECT, key: KEY, value: "weekly",
    actor: "user", note: "tester S27 live probe", causedByMessage: "run the prune weekly",
  } as any);
  check("the first write is applied", true, r1.applied);
  check("and it is version 1", 1, r1.version);

  const r2: any = await applyConfigChange(pool, {
    scope: "project", projectId: PROJECT, key: KEY, value: "daily",
    actor: "user", note: "tester S27 live probe", causedByMessage: "actually make it daily",
  } as any);
  check("a second write is version 2", 2, r2.version);

  const rows = await pool.query<{ version: number; actor: string; note: string;
    caused_by_message: string; supersedes: string | null }>(
    "SELECT version, actor, note, caused_by_message, supersedes FROM config_versions WHERE key=$1 ORDER BY version", [KEY]);
  check("provenance: actor recorded", "user", rows.rows[1].actor);
  check("provenance: his words recorded", "actually make it daily", rows.rows[1].caused_by_message);
  (rows.rows[1].supersedes ? ok("version 2 points at the version it superseded")
    : bad("version 2 supersedes v1", "a uuid", rows.rows[1].supersedes));

  console.log("\n=== the audit row is part of the same write ===");
  const after = await pool.query<{ n: string }>(
    "SELECT count(*) n FROM audit_events WHERE action = 'config.change'");
  const grew = Number(after.rows[0].n) - Number(before.rows[0].n);
  check("two writes produced two config.change audit rows", 2, grew);

  console.log("\n=== rollback writes history, it does not rewrite it ===");
  const rb: any = await rollbackConfig(pool, {
    projectId: PROJECT, key: KEY, toVersion: 1, actor: "user", note: "tester S27 rollback",
  } as any);
  const all = await pool.query<{ version: number; value: any }>(
    "SELECT version, value FROM config_versions WHERE key=$1 ORDER BY version", [KEY]);
  check("rollback added a THIRD version rather than editing one", 3, all.rows.length);
  check("and the new version restores version 1's value exactly",
    JSON.stringify(all.rows[0].value), JSON.stringify(all.rows[2].value));
  check("while version 2 still says what it always said", JSON.stringify("daily"), JSON.stringify(all.rows[1].value));

  await pool.query("DELETE FROM config_versions WHERE key = $1", [KEY]);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
