/**
 * Unscoped heavy work fails closed.
 *
 * On a real call the sentence "Hello, can you finish what you were saying?" -
 * conversational filler - became a heavy task with no project. It was given an
 * empty directory under `worktrees/unscoped`, the harness was started in it,
 * and Claude correctly reported there was nothing to continue from. While
 * looking around it ran `ls -la /var/lib/jarvis/worktrees/unscoped/`, which is
 * outside the paths the run may touch, so the isolation tripwire killed the run
 * and raised a CRITICAL.
 *
 * The tripwire was right. A run whose boundary is an empty scratch directory has
 * no meaningful boundary, so the fix is upstream: the heavy lane refuses the
 * task instead of starting a harness with nothing to work on.
 */
import { createPool } from "../src/db.js";
import { runHeavyTask } from "../src/runner.js";

const pool = createPool();
let fails = 0;
/*
 * `passes` exists for the sweep, not for the reader.
 *
 * scripts/sweep.sh decides whether a suite ran by grepping for one exact line:
 * `==== N passed, M failed ====`. These suites printed their own summary instead,
 * so the sweep reported all seven as "NO SUMMARY - the suite did not finish"
 * while each of them passed perfectly well on its own. Adding a suite to the net
 * is not the same as the net being able to see it.
 */
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function main() {
  console.log("1. a heavy task with no project is parked, not run");
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (lane, title, objective, state)
     VALUES ('heavy', 'Hello, can you finish what you were saying?', 'filler', 'queued')
     RETURNING id`,
  );
  const id = t.rows[0].id;

  await runHeavyTask(pool, id);

  const after = await pool.query<{ state: string; waiting_reason: string | null }>(
    `SELECT state, waiting_reason FROM tasks WHERE id = $1`, [id],
  );
  const state = after.rows[0]?.state;
  state === "waiting_for_user"
    ? ok(`parked: ${after.rows[0]?.waiting_reason ?? ""}`)
    : bad(`state is ${state}, expected waiting_for_user`);

  console.log("2. the harness was never started");
  /*
   * Asserted on the state history, not on the worktree directory.
   *
   * The first version checked that `worktrees/unscoped/<id>` did not exist
   * afterwards - and passed even with the guard removed, because the runner
   * removes its worktree in a `finally`. Absence after the fact says nothing
   * about whether a harness ran in it. Reaching `running` is what "a harness was
   * started" means, and it cannot be cleaned up behind the test.
   */
  const ran = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM task_transitions WHERE task_id = $1 AND to_state = 'running'`,
    [id],
  );
  Number(ran.rows[0]?.n ?? 0) === 0
    ? ok("never entered running")
    : bad("the task reached running - a harness was started in an empty directory");

  console.log("3. the ticket names the sentence that caused it");
  const issue = await pool.query<{ required_action: string; severity: string; category: string }>(
    `SELECT required_action, severity, category FROM issues
      WHERE dedupe_key = 'runner.heavy.unscoped' ORDER BY updated_at DESC LIMIT 1`,
  );
  const row = issue.rows[0];
  if (!row) bad("no Issue was raised");
  else {
    row.required_action.includes("Hello, can you finish")
      ? ok("the required action quotes the task")
      : bad(`required_action does not name the task: ${row.required_action.slice(0, 70)}`);
    // The old behaviour raised a CRITICAL isolation alert for a directory
    // listing. This is a misrouted task, which is a configuration problem.
    row.severity !== "critical"
      ? ok(`severity ${row.severity}, not critical`)
      : bad("still raising a CRITICAL for what is a misrouted task");
  }

  await pool.query(`DELETE FROM issues WHERE dedupe_key = 'runner.heavy.unscoped'`);
  await pool.query(`DELETE FROM task_transitions WHERE task_id = $1`, [id]);
  await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [id]);
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  await pool.end();

  console.log(`
==== ${passes} passed, ${fails} failed ====`);

  console.log(fails === 0 ? "\nUnscoped heavy work PASS" : `\nUnscoped heavy work FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
