/**
 * S29's escalation half: down is the default, and failure buys the way up.
 *
 * The plan is specific about what to assert, and about the trap: "Assert on
 * WHICH ROUTE RAN SECOND, not on the task eventually succeeding - a lateral
 * switch also eventually succeeds sometimes, and costs the same as the
 * failure." Rung 8 did exactly that lateral move, taking any other approved
 * route for the role ordered by route_order.
 */
import { createPool } from "../src/db.js";
import { climb } from "../src/ladder.js";

const pool = createPool();
let fails = 0;
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const STAMP = Date.now();
const CHEAP = `s29cheap${STAMP}`;
const PEER = `s29peer${STAMP}`;
const DEAR = `s29dear${STAMP}`;

async function profile(id: string, poolName: string, order: number): Promise<void> {
  await pool.query(
    `INSERT INTO auth_profiles (id, provider, display_name, auth_type, health)
     VALUES ($1, 'test', $1, 'api_key', 'healthy') ON CONFLICT (id) DO NOTHING`, [id]);
  await pool.query(
    `INSERT INTO model_registry (model_id, provider, auth_profile_id, role_assignments,
                                 approval_state, health, route_order, pool)
     VALUES ($1, 'test', $1, ARRAY['senior_engineer'], 'approved', 'healthy', $2, $3)
     ON CONFLICT DO NOTHING`, [id, order, poolName]);
}

async function task(profileId: string | null): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tasks (lane, title, objective, state, model_role, auth_profile_id)
     VALUES ('heavy', 's29 escalation', 'x', 'recovering', 'senior_engineer', $1) RETURNING id`,
    [profileId]);
  return r.rows[0].id;
}

async function routeOf(id: string): Promise<string | null> {
  const r = await pool.query<{ p: string | null }>(
    `SELECT auth_profile_id AS p FROM tasks WHERE id = $1`, [id]);
  return r.rows[0]?.p ?? null;
}

async function main() {
  const made: string[] = [];

  // A cheap normal route, a PEER at the same tier, and a dearer escalation one.
  // The peer exists so a lateral move is available: without it, "escalated"
  // and "took the only other route" are indistinguishable.
  await profile(CHEAP, "normal", 10);
  await profile(PEER, "normal", 20);
  await profile(DEAR, "escalation", 30);

  console.log("1. a task that fails on its normal route escalates UPWARD, not sideways");
  const t1 = await task(CHEAP);
  made.push(t1);
  /*
   * Climbed, not jumped to.
   *
   * The ladder starts at rung 1 and rung 8 is only reached after the cheaper
   * remedies have been tried, so the test drives it the way a failing task
   * does. Calling climb once asserts rung 1 and nothing about escalation - the
   * first version of this did exactly that and reported the route unchanged.
   */
  const climbed: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    await pool.query(`UPDATE tasks SET state = 'recovering' WHERE id = $1`, [t1]);
    const step = await climb(pool, t1, "the harness failed its own tests");
    climbed.push(`${step.rung}:${step.name}`);
    if (step.name === "switch_model" || step.rung >= 9) break;
  }
  console.log(`     climbed ${climbed.join(" -> ")}`);
  const second = await routeOf(t1);
  second === DEAR
    ? ok(`second route is the escalation one (${second})`)
    : bad(`second route is ${second} - ${second === PEER ? "a lateral move to an equal-cost peer" : "unexpected"}`);

  console.log("2. the escalation is recorded, countable by shape");
  const rec = await pool.query<{ shape: string; from_profile: string; to_profile: string }>(
    `SELECT shape, from_profile, to_profile FROM escalations WHERE task_id = $1`, [t1]);
  rec.rowCount === 1 ? ok(`recorded ${rec.rows[0].from_profile} -> ${rec.rows[0].to_profile}`)
    : bad(`${rec.rowCount} escalation rows`);
  rec.rows[0]?.shape === "senior_engineer"
    ? ok("keyed by the shape a pool is assigned by")
    : bad(`shape is ${rec.rows[0]?.shape}`);

  console.log("3. a task that never failed never touches the escalation pool");
  // Both halves, or escalation is just routing with extra words.
  const t2 = await task(CHEAP);
  made.push(t2);
  const untouched = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM escalations WHERE task_id = $1`, [t2]);
  Number(untouched.rows[0].n) === 0 && (await routeOf(t2)) === CHEAP
    ? ok("still on its cheap route, no escalation recorded")
    : bad("a task that did not fail was escalated");

  console.log("4. an empty escalation pool fails cleanly rather than escalating to nothing");
  await pool.query(`UPDATE model_registry SET pool = 'normal' WHERE auth_profile_id = $1`, [DEAR]);
  const t3 = await task(CHEAP);
  made.push(t3);
  let step = { rung: 0, name: "none" } as { rung: number; name: string };
  for (let i = 0; i < 10; i += 1) {
    await pool.query(`UPDATE tasks SET state = 'recovering' WHERE id = $1`, [t3]);
    step = await climb(pool, t3, "the harness failed its own tests");
    if (step.name === "switch_model" || step.rung >= 9) break;
  }
  const after = await routeOf(t3);
  after === CHEAP
    ? ok(`route unchanged; the ladder moved on (rung ${step.rung} ${step.name})`)
    : bad(`route became ${after} with an empty escalation pool`);
  const none = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM escalations WHERE task_id = $1`, [t3]);
  Number(none.rows[0].n) === 0 ? ok("and nothing was recorded as an escalation") : bad("recorded a phantom escalation");

  for (const t of made) {
    await pool.query(`DELETE FROM issues WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM escalations WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM task_transitions WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [t]);
  }
  await pool.query(`DELETE FROM model_registry WHERE auth_profile_id = ANY($1)`, [[CHEAP, PEER, DEAR]]);
  await pool.query(`DELETE FROM auth_profiles WHERE id = ANY($1)`, [[CHEAP, PEER, DEAR]]);
  await pool.end();

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
