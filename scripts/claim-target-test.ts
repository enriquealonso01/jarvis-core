/**
 * A runner pointed at one task takes that task, or nothing.
 *
 * `RUNNER_ONCE=1` claims ONE task and exits, and the suites that use it create a
 * fixture and then assume the runner they started will take it. It takes the
 * OLDEST queued task on the lane, which is a different thing the moment anything
 * else is queued — and on a box several sessions share, something else always
 * is. `s4-drain` failed exactly that way: its runner claimed another suite's
 * leftover, s4-drain's own task never left `queued`, and every assertion after
 * "the task is running" fell over. A red suite that had found nothing.
 *
 * The property that matters is the NEGATIVE one, and it is the whole reason this
 * is a target rather than a preference: **a target never falls back.** A runner
 * that quietly ran a different task than the one a test named would make the
 * test lie rather than fail, which is worse than the flake it replaces.
 *
 * Asserted against `claimTask` directly rather than by starting containers: what
 * is being tested is which row the SELECT picks, and a container adds ninety
 * seconds and three more ways to be flaky without adding an assertion.
 */
import { claimTask } from "../src/jobs.js";
import { createPool } from "../src/db.js";
import { deleteProjects } from "./_teardown.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `claimt-${Math.random().toString(36).slice(2, 8)}`;
/* Its own lane, so this suite can never claim work another session is waiting on. */
const LANE = "heavy";

async function main(): Promise<void> {
  let project = "";
  const made: string[] = [];
  try {
    project = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug, name, project_type) VALUES ($1,$1,'personal') RETURNING id`,
      [SLUG])).rows[0].id;

    /*
     * Every OTHER queued task on the lane is parked for the duration, so "the
     * oldest one" is a fact about this suite's fixtures rather than about
     * whatever the box happens to be doing. Restored in the finally: borrowing
     * the queue and not giving it back is the fault s4-drain and s11-recovery
     * were just fixed for, one table over.
     */
    const parked = (await pool.query<{ id: string }>(
      `UPDATE tasks SET lease_until = now() + interval '2 minutes'
        WHERE lane = $1 AND state = 'queued' AND lease_until IS NULL
        RETURNING id`, [LANE])).rows.map((r) => r.id);

    const queue = async (title: string, priority = "normal"): Promise<string> => {
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
         VALUES ($1,$2,'x','queued',$3,$4) RETURNING id`,
        [project, title, LANE, priority])).rows[0].id;
      made.push(id);
      return id;
    };

    try {
      console.log("1. without a target, the oldest goes first");
      const older = await queue(`${SLUG} older`);
      const newer = await queue(`${SLUG} newer`);
      const untargeted = await claimTask(pool, LANE, "test-claimer");
      untargeted === older
        ? ok("the queue is still a queue")
        : bad(`claimed ${untargeted === newer ? "the newer task" : untargeted}`);
      await release(older);

      console.log("");
      console.log("2. with a target, the named task goes first");
      /*
       * THE FAILURE THIS EXISTS FOR. The older task is still queued and still
       * older; a runner pointed at the newer one must take the newer one anyway.
       */
      const targeted = await claimTask(pool, LANE, "test-claimer", newer);
      targeted === newer
        ? ok("the named task is claimed even with an older one queued ahead of it")
        : bad(`THE TARGET WAS IGNORED: claimed ${targeted === older ? "the older task" : targeted}`);
      (await state(older)) === "queued"
        ? ok("and the older one is left alone rather than consumed")
        : bad("the untargeted task was claimed too");
      await release(newer);

      console.log("");
      console.log("3. a target never falls back");
      /*
       * The negative half, and the reason this is a target rather than a
       * preference. Each of these is a task that EXISTS and is not claimable;
       * with something else queued and ready, a fallback would look like
       * success.
       */
      const available = await queue(`${SLUG} available`);
      const notQueued = await queue(`${SLUG} already running`);
      await pool.query(`UPDATE tasks SET state = 'running' WHERE id = $1`, [notQueued]);
      await claimTask(pool, LANE, "test-claimer", notQueued) === null
        ? ok("a task that is not queued yields nothing, not the next one along")
        : bad("A TARGET FELL BACK to another task");

      const leased = await queue(`${SLUG} cooling off`);
      await pool.query(
        `UPDATE tasks SET lease_until = now() + interval '5 minutes' WHERE id = $1`, [leased]);
      await claimTask(pool, LANE, "test-claimer", leased) === null
        ? ok("a task still inside its backoff yields nothing")
        : bad("a target ignored the cooling-off period");

      const otherLane = (await pool.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
         VALUES ($1,$2,'x','queued','system','normal') RETURNING id`,
        [project, `${SLUG} other lane`])).rows[0].id;
      made.push(otherLane);
      await claimTask(pool, LANE, "test-claimer", otherLane) === null
        ? ok("and a task on another lane yields nothing, so the lane still means something")
        : bad("a target crossed lanes");

      /*
       * And the control: with all three refused, the available task was there
       * the whole time. If any of the assertions above passed because the queue
       * was empty they proved nothing, so the queue is shown to be non-empty
       * afterwards rather than assumed.
       */
      (await state(available)) === "queued"
        ? ok("with a claimable task queued throughout, so 'nothing' was a refusal and not an empty queue")
        : bad("the control task was consumed, so the refusals above prove nothing");

      console.log("");
      console.log("4. and the target is what the runner reads");
      /*
       * Source level, because the suite above exercises claimTask and that is
       * not the same as the runner passing its env through — the mistake this
       * repo has now made twice, in S41 and S39.
       */
      const fs = await import("node:fs/promises");
      const runner = await fs.readFile(new URL("../src/runner.ts", import.meta.url), "utf8");
      /RUNNER_TASK_ID/.test(runner) && /claimTask\(pool, "heavy", RUNNER_ID, only\)/.test(runner)
        ? ok("the runner claims with the task it was pointed at")
        : bad("the runner reads the variable and does not pass it to claimTask");
      const drain = await fs.readFile(new URL("../scripts/s4-drain-test.sh", import.meta.url), "utf8");
      (drain.match(/RUNNER_TASK_ID/g) ?? []).length >= 2
        ? ok("and both of s4-drain's runners are pointed at its own task")
        : bad("s4-drain still starts a runner that takes whatever is oldest");
    } finally {
      if (parked.length) {
        await pool.query(
          `UPDATE tasks SET lease_until = NULL WHERE id = ANY($1::uuid[])`, [parked]);
      }
    }
  } finally {
    if (made.length) {
      await pool.query(
        `UPDATE tasks SET state = 'cancelled', lease_owner = NULL WHERE id = ANY($1::uuid[])`,
        [made]).catch(() => undefined);
    }
    if (project) await deleteProjects(pool, [project]);
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

async function state(id: string): Promise<string> {
  return (await pool.query<{ state: string }>(
    `SELECT state FROM tasks WHERE id = $1`, [id])).rows[0].state;
}

/** Put a claimed task back, so the next section starts from a known queue. */
async function release(id: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_until = NULL WHERE id = $1`,
    [id]);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
