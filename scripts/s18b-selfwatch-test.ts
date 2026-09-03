/**
 * S18b — nobody is watching the watchdog.
 *
 * The failure this guards is the quietest one in the system: a stopped watchdog
 * produces the same console a calm system produces. So the assertions are
 * mostly about what happens when NOTHING happens - a component that never
 * recorded a sweep must read as stale rather than unknown, and a sweep record
 * that stops moving must raise an incident from a reader that is not the
 * watchdog.
 */
import { createPool } from "../src/db.js";
import {
  recordBlindWindow, recordSweep, reconcileExpiredLeases, reconcileSweepIncident, sweepHealth,
} from "../src/selfwatch.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const COMPONENT = `test-watchdog-${Math.random().toString(36).slice(2, 8)}`;

async function main(): Promise<void> {
  console.log("1. a component nobody has heard from is stale, not unknown");
  const never = await sweepHealth(pool, COMPONENT);
  never.stale && never.lastCompletedAt === null
    ? ok("a component with no sweep record reads as stale")
    : bad(`an unheard-of component reported ${JSON.stringify(never)}`);
  never.detail.includes("never")
    ? ok("and says so in words")
    : bad(`unhelpful detail: ${never.detail}`);

  console.log("");
  console.log("2. a completed sweep is recorded, and counted");
  await recordSweep(pool, COMPONENT, "worker-test");
  await recordSweep(pool, COMPONENT, "worker-test");
  const fresh = await sweepHealth(pool, COMPONENT);
  !fresh.stale ? ok("a fresh sweep is not stale") : bad(`fresh sweep read as stale: ${fresh.detail}`);
  fresh.sweeps === 2
    ? ok("sweeps are counted, so a component that finished once and stopped is visible")
    : bad(`sweep count was ${fresh.sweeps}`);
  fresh.owner === "worker-test"
    ? ok("and the owner is recorded, so a change of hand shows")
    : bad(`owner was ${fresh.owner}`);

  console.log("");
  console.log("3. a stale sweep raises an incident, from a reader that is not the watchdog");
  // Aged by hand: waiting five minutes to assert a five-minute rule is a test
  // nobody runs.
  await pool.query(
    `UPDATE component_sweeps SET last_completed_at = now() - interval '11 minutes' WHERE component = $1`,
    [COMPONENT],
  );
  const stale = await sweepHealth(pool, COMPONENT);
  stale.stale ? ok(`an 11-minute-old sweep is stale (${stale.ageSeconds}s)`) : bad("an old sweep read as healthy");

  const opened = await reconcileSweepIncident(pool, stale, "test-reader");
  opened === "opened" ? ok("the reader opens an incident") : bad(`reconcile returned ${opened}`);
  const again = await reconcileSweepIncident(pool, stale, "test-reader");
  again === "unchanged"
    ? ok("and a second reader does not open a duplicate")
    : bad(`a duplicate incident was ${again}`);

  const inc = await pool.query<{ summary: string; severity: string }>(
    `SELECT summary, severity FROM health_incidents WHERE service = $1 AND closed_at IS NULL`, [COMPONENT]);
  inc.rows[0]?.summary.includes("test-reader")
    ? ok("the incident names who noticed, not who failed")
    : bad(`summary was ${inc.rows[0]?.summary}`);

  console.log("");
  console.log("4. it closes again when sweeps resume");
  await recordSweep(pool, COMPONENT, "worker-test-2");
  const recovered = await sweepHealth(pool, COMPONENT);
  const closed = await reconcileSweepIncident(pool, recovered, "test-reader");
  closed === "closed" ? ok("the incident closes on its own") : bad(`reconcile returned ${closed}`);
  const stillOpen = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM health_incidents WHERE service = $1 AND closed_at IS NULL`, [COMPONENT]);
  Number(stillOpen.rows[0].n) === 0
    ? ok("and nothing is left open to keep the console red")
    : bad(`${stillOpen.rows[0].n} incident(s) still open`);

  console.log("");
  console.log("5. the blind window is written down, not skipped");
  await pool.query(
    `UPDATE component_sweeps SET last_completed_at = now() - interval '40 minutes' WHERE component = $1`,
    [COMPONENT],
  );
  const gap = await recordBlindWindow(pool, COMPONENT, "worker-test-3");
  gap !== null && gap > 2000
    ? ok(`a 40-minute gap is recorded as a blind window (${gap}s)`)
    : bad(`blind window returned ${gap}`);
  const window = await pool.query<{ summary: string }>(
    `SELECT summary FROM health_incidents WHERE service = $1 AND summary LIKE 'blind window%'`, [COMPONENT]);
  window.rows.length === 1
    ? ok("and it lands on the timeline where the unwatched minutes would otherwise read as healthy")
    : bad(`${window.rows.length} blind-window records`);

  await recordSweep(pool, COMPONENT, "worker-test-3");
  const noGap = await recordBlindWindow(pool, COMPONENT, "worker-test-3");
  noGap === null
    ? ok("a restart with no real gap records nothing")
    : bad(`a short gap was recorded as a blind window: ${noGap}`);

  console.log("");
  console.log("6. an expired lease is released; a live one is not");
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality) VALUES ($1,$1,'personal','normal') RETURNING id`,
    [`selfwatch-${Math.random().toString(36).slice(2, 7)}`]);
  const pid = p.rows[0].id;
  const dead = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority,lease_owner,lease_until)
     VALUES ($1,'dead','x','running','heavy','normal','gone-worker', now() - interval '5 minutes')
     RETURNING id`, [pid]);
  const alive = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority,lease_owner,lease_until)
     VALUES ($1,'alive','x','running','heavy','normal','live-worker', now() + interval '5 minutes')
     RETURNING id`, [pid]);

  await reconcileExpiredLeases(pool);
  const after = await pool.query<{ id: string; lease_owner: string | null }>(
    `SELECT id, lease_owner FROM tasks WHERE id = ANY($1)`, [[dead.rows[0].id, alive.rows[0].id]]);
  const deadRow = after.rows.find((x) => x.id === dead.rows[0].id);
  const aliveRow = after.rows.find((x) => x.id === alive.rows[0].id);
  deadRow?.lease_owner === null
    ? ok("the expired lease is released, so the lane is not held by a dead worker")
    : bad(`expired lease still held by ${deadRow?.lease_owner}`);
  aliveRow?.lease_owner === "live-worker"
    ? ok("and a live lease is left alone, because its holder may still be working")
    : bad(`a live lease was cleared: ${JSON.stringify(aliveRow)}`);

  // Clean up
  await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  await pool.query(`DELETE FROM health_incidents WHERE service = $1`, [COMPONENT]);
  await pool.query(`DELETE FROM component_sweeps WHERE component = $1`, [COMPONENT]);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
