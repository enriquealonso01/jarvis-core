/**
 * S31 Debug: a server that hangs must not take the heavy lane with it.
 *
 * "An MCP server that hangs takes the heavy lane with it: every MCP invocation
 * needs a timeout, and a server that times out twice gets disabled with an
 * Issue rather than retried forever."
 *
 * The assertions are about the three things that go wrong in that order:
 *
 *  - no timeout at all, so one hung call holds the lane until something else
 *    kills it;
 *  - a timeout but no memory, so the same dead server is retried forever, one
 *    unlucky task at a time;
 *  - a CUMULATIVE counter instead of a consecutive one, which eventually
 *    disables a working connection for being old rather than for being broken.
 *    That last one is why a successful call has to clear the streak, and it is
 *    asserted here rather than assumed.
 *
 * The timeout used is deliberately tiny. A test that waits the real twenty
 * seconds to prove a twenty-second timeout is a test nobody runs.
 */
import { createPool } from "../src/db.js";
import { invoke, TIMEOUTS_BEFORE_DISABLE, type Adapter, type ConnectorKind } from "../src/connector.js";
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

const SERVER = `s31-hang-${STAMP}`;

/** Hangs when told to, answers when told to. Nothing else. */
let hang = true;
let started = 0;
const flaky: Adapter = {
  kind: "mcp",
  async invoke() {
    started += 1;
    if (!hang) return { ok: true };
    await new Promise(() => { /* never settles - exactly what a wedged server does */ });
    return { unreachable: true };
  },
};

async function state(id: string) {
  const r = await pool.query<{ disabled_at: Date | null; consecutive_timeouts: number; disabled_reason: string | null }>(
    `SELECT disabled_at, consecutive_timeouts, disabled_reason FROM connections WHERE id = $1`, [id]);
  return r.rows[0];
}

async function main(): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,'personal','normal','non_production')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`, [`s31hang-${STAMP}`]);
  const proj = p.rows[0].id;
  created.push(proj);

  const c = await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, config, health)
     VALUES ($1,'mcp','shared','{}','healthy') RETURNING id`, [SERVER]);
  const conn = c.rows[0].id;
  connIds.push(conn);
  await pool.query(`INSERT INTO connection_project_allowlist (connection_id, project_id) VALUES ($1,$2)`,
    [conn, proj]);
  await pool.query(
    `INSERT INTO connection_actions (connection_id, action, level, classified_by)
     VALUES ($1,'slow_tool',1,'s31-test')`, [conn]);

  const adapters = new Map<ConnectorKind, Adapter>([["mcp", flaky]]);
  const call = () => invoke(pool, adapters, {
    connectionSlug: SERVER, action: "slow_tool", projectId: proj, timeoutMs: 150 });

  console.log("\n########## a hung call ends ##########\n");
  {
    const began = Date.now();
    const r = await call();
    const took = Date.now() - began;
    !r.ok && r.code === "connector.timeout"
      ? ok(`the call gave up after ${took}ms instead of holding the lane`)
      : bad("a hung call did not time out", r.ok ? "it returned" : r.code);
    took < 5000 ? ok("and returned promptly") : bad(`took ${took}ms`);

    const s = await state(conn);
    s.consecutive_timeouts === 1 ? ok("the timeout is counted") : bad(`count is ${s.consecutive_timeouts}`);
    s.disabled_at === null ? ok("and one timeout does not disable it") : bad("disabled after a single timeout");
  }

  console.log("\n########## twice in a row is broken ##########\n");
  {
    const r = await call();
    !r.ok ? ok("the second call times out too") : bad("the second call somehow succeeded");

    const s = await state(conn);
    s.consecutive_timeouts >= TIMEOUTS_BEFORE_DISABLE
      ? ok(`the streak reached ${s.consecutive_timeouts}`)
      : bad(`streak is only ${s.consecutive_timeouts}`);
    s.disabled_at !== null
      ? ok(`and the connection is disabled: ${s.disabled_reason}`)
      : bad("it was not disabled after two timeouts");

    const issue = await pool.query<{ title: string; status: string }>(
      `SELECT title, status FROM issues WHERE dedupe_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [`connector.timeout:${SERVER}`]);
    issue.rows[0]
      ? ok(`an Issue was raised: ${issue.rows[0].title}`)
      : bad("no Issue was raised for the disabled connection");
  }

  console.log("\n########## disabled means not called ##########\n");
  {
    const before = started;
    const r = await call();
    !r.ok && r.reason.includes("disabled")
      ? ok("a disabled connection refuses, saying so")
      : bad("a disabled connection did not refuse clearly", r.ok ? "it ran" : r.reason);
    started === before
      ? ok("and the adapter is never reached, so a dead server costs nothing")
      : bad(`the adapter was called ${started - before} more time(s)`);
  }

  console.log("\n########## consecutive, not cumulative ##########\n");
  {
    /*
     * Bring it back the way an operator would, then let ONE call succeed and
     * one hang. A cumulative counter would already be at two and would disable
     * a connection that is working - which is the failure this half exists to
     * prevent.
     */
    await pool.query(
      `UPDATE connections SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1`, [conn]);

    hang = false;
    const good = await call();
    good.ok ? ok("it works again once the server answers") : bad("the recovered call failed", !good.ok && good.reason);

    const afterGood = await state(conn);
    afterGood.consecutive_timeouts === 0
      ? ok("and a successful call clears the streak")
      : bad(`streak survived a success: ${afterGood.consecutive_timeouts}`);

    hang = true;
    await call();
    const afterOne = await state(conn);
    afterOne.disabled_at === null
      ? ok("so a single later timeout does not disable a working connection")
      : bad("one timeout after a success disabled it - the counter is cumulative");
  }

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); fail += 1; })
  .finally(async () => {
    await pool.query(`DELETE FROM issues WHERE dedupe_key = $1`, [`connector.timeout:${SERVER}`]).catch(() => undefined);
    for (const id of connIds) {
      await pool.query(`DELETE FROM connection_actions WHERE connection_id = $1`, [id]).catch(() => undefined);
      await pool.query(`DELETE FROM connection_project_allowlist WHERE connection_id = $1`, [id]).catch(() => undefined);
      await pool.query(`DELETE FROM connections WHERE id = $1`, [id]).catch(() => undefined);
    }
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
