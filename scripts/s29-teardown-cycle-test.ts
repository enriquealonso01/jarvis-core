/**
 * A teardown that meets a cycle must break it, not give up quietly.
 *
 * tasks -> issues -> tasks: an issue belongs to a task, and a task can be
 * blocked BY an issue. The descent stopped at a fixed depth and returned
 * without a word, which did NOT stop the deletes already queued above it - so
 * tasks were deleted while their issues remained and the whole teardown rolled
 * back on a foreign key. Four benchmark projects leaked that way before anyone
 * noticed, because a rolled-back teardown reports "cleaned up" with an empty
 * list and reads like success.
 *
 * This builds the cycle on purpose and requires the teardown to survive it.
 */
import { createPool } from "../src/db.js";
import { teardownFixtureProject, teardownTask } from "./lib/fixture.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s29-cycle-${Math.random().toString(36).slice(2, 8)}`;

async function main(): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality)
     VALUES ($1, $1, 'personal', 'normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;

  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
     VALUES ($1, 'cycle', 'x', 'waiting_for_user', 'heavy', 'normal') RETURNING id`, [pid]);
  const taskId = t.rows[0].id;

  const i = await pool.query<{ id: string }>(
    `INSERT INTO issues (project_id, task_id, title, category, status, severity, service, owner)
     VALUES ($1, $2, 'blocked on a person', 'agent.repeat', 'waiting_for_user', 'medium', 'runner', 'jarvis')
     RETURNING id`, [pid, taskId]);
  const issueId = i.rows[0].id;

  // The edge that closes the loop.
  await pool.query(`UPDATE tasks SET blocked_by_issue_id = $2 WHERE id = $1`, [taskId, issueId]);

  const closed = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks t JOIN issues i ON i.task_id = t.id
      WHERE t.id = $1 AND t.blocked_by_issue_id = i.id`, [taskId]);
  Number(closed.rows[0].n) === 1
    ? ok("the cycle exists: a task blocked by an issue that belongs to it")
    : bad("could not build the cycle, so this test proves nothing");

  console.log("");
  let threw: string | null = null;
  const result = await teardownFixtureProject(pool, pid).catch((e: unknown) => {
    threw = e instanceof Error ? e.message : String(e);
    return null;
  });

  threw === null
    ? ok("the teardown completed rather than throwing")
    : bad(`the teardown threw: ${threw}`);
  result && result.leftBehind.length === 0
    ? ok("and left nothing behind")
    : bad(`left behind: ${JSON.stringify(result?.leftBehind ?? "n/a")}`);

  const gone = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM projects WHERE id = $1`, [pid]);
  Number(gone.rows[0].n) === 0
    ? ok("the project is actually gone, not merely reported gone")
    : bad("the project survived the teardown");

  const orphan = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM issues WHERE id = $1`, [issueId]);
  Number(orphan.rows[0].n) === 0
    ? ok("and so is the issue that closed the cycle")
    : bad("the issue outlived its project");


  // ---- the same cycle, torn down from the task instead of the project
  console.log("");
  console.log("the benchmark reuses its project, so the per-run cleanup is a task");
  const p2 = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality)
     VALUES ($1, $1, 'personal', 'normal') RETURNING id`, [`${SLUG}-keep`]);
  const pid2 = p2.rows[0].id;
  const t2 = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
     VALUES ($1, 'cycle2', 'x', 'waiting_for_user', 'heavy', 'normal') RETURNING id`, [pid2]);
  const task2 = t2.rows[0].id;
  const i2 = await pool.query<{ id: string }>(
    `INSERT INTO issues (project_id, task_id, title, category, status, severity, service, owner)
     VALUES ($1, $2, 'blocked', 'agent.repeat', 'waiting_for_user', 'medium', 'runner', 'jarvis')
     RETURNING id`, [pid2, task2]);
  await pool.query(`UPDATE tasks SET blocked_by_issue_id = $2 WHERE id = $1`, [task2, i2.rows[0].id]);

  const tt = await teardownTask(pool, task2).catch((e: unknown) => {
    bad(`teardownTask threw: ${e instanceof Error ? e.message : e}`);
    return null;
  });
  tt && tt.leftBehind.length === 0
    ? ok("the task and its cycle are gone")
    : bad(`left behind: ${JSON.stringify(tt?.leftBehind ?? "n/a")}`);
  const survived = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM projects WHERE id = $1`, [pid2]);
  Number(survived.rows[0].n) === 1
    ? ok("and the project it belonged to is untouched, which is the point")
    : bad("tearing down a task took its project with it");
  await teardownFixtureProject(pool, pid2).catch(() => null);

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
