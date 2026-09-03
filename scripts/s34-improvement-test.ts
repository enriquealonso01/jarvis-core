/**
 * S34 — the scan that suggests and never acts.
 *
 *   "Force an Improvement run and confirm nothing activates itself. Decline a
 *    candidate, then run the scan again → it does not come back. Change its
 *    version and run again → it returns, and the message names what changed
 *    rather than repeating the pitch. A week with twenty findings produces the
 *    capped number of asks and the rest in the console. Approve one → a task
 *    exists; one-tap approval that produces no work is a button, not a
 *    decision."
 *
 * "Nothing activates itself" is asserted as an ABSENCE across a whole scan -
 * no task, no schedule, no config change - rather than by checking one thing,
 * because the interesting version of this bug is a scan that acts on the one
 * category nobody thought to check.
 */
import { createPool } from "../src/db.js";
import {
  approve, ASK_CAP, askLine, decline, fingerprint, recordScan, type Candidate,
} from "../src/improvement.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const TAG = `s34imp-${Math.random().toString(36).slice(2, 7)}`;
const cand = (n: number, proposal: Record<string, unknown> = { action: "add", n }): Candidate => ({
  key: `${TAG}-${n}`,
  title: `${TAG} finding ${n}`,
  pitch: `I could do thing ${n}`,
  proposal,
});

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [TAG])).rows[0].id;
  try {
    console.log("1. a week with twenty findings");
    const twenty = Array.from({ length: 20 }, (_, i) => cand(i + 1));
    const tasksBefore = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM tasks`)).rows[0].n);
    const schedulesBefore = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM schedules`)).rows[0].n);
    const scan = await recordScan(pool, twenty);
    scan.open.length === 20 ? ok("all twenty are on the console") : bad(`${scan.open.length} open`);
    scan.asks.length === ASK_CAP
      ? ok(`and exactly ${ASK_CAP} become asks — twenty suggestions is a feed`)
      : bad(`${scan.asks.length} asks, cap is ${ASK_CAP}`);

    console.log("");
    console.log("2. nothing activated itself");
    /*
     * The absence, across everything a scan could plausibly touch. Checking
     * only "no task" would pass on a scan that quietly enabled a schedule.
     */
    const tasksAfter = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM tasks`)).rows[0].n);
    const schedulesAfter = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM schedules`)).rows[0].n);
    const approved = Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM improvement_candidates WHERE status = 'approved'`)).rows[0].n);
    tasksAfter === tasksBefore && schedulesAfter === schedulesBefore && approved === 0
      ? ok(`a full scan created no task, no schedule and approved nothing (${tasksBefore} tasks before and after)`)
      : bad(`the scan acted: tasks ${tasksBefore}->${tasksAfter}, schedules ${schedulesBefore}->${schedulesAfter}, approved ${approved}`);

    console.log("");
    console.log("3. decline one, and it does not come back");
    await decline(pool, `${TAG}-1`);
    const second = await recordScan(pool, twenty);
    second.stillDeclined.includes(`${TAG}-1`)
      ? ok("the same twenty are scanned again and the declined one is suppressed")
      : bad("a declined candidate was re-offered");
    !second.open.some((c) => c.key === `${TAG}-1`)
      ? ok("it is not even on the console list of open candidates")
      : bad("the declined candidate is still open");
    const seen = (await pool.query<{ times_seen: number }>(
      `SELECT times_seen FROM improvement_candidates WHERE candidate_key = $1`, [`${TAG}-1`])).rows[0];
    seen?.times_seen === 1
      ? ok("and its seen-count did not climb, so nothing accumulates a case for asking again")
      : bad(`the declined candidate has been counted ${seen?.times_seen} times`);

    console.log("");
    console.log("4. change what it would DO, and it returns saying so");
    const changed = twenty.map((c) => c.key === `${TAG}-1` ? cand(1, { action: "add", n: 1, andAlso: "restart" }) : c);
    const third = await recordScan(pool, changed);
    third.returned.some((r) => r.key === `${TAG}-1`)
      ? ok("a changed proposal comes back")
      : bad("a changed proposal stayed suppressed");
    const back = third.open.find((c) => c.key === `${TAG}-1`);
    back?.changedSinceDecline === true
      ? ok("marked as something he had declined")
      : bad("it came back without saying it had been declined");
    const line = askLine(back!, third.returned.find((r) => r.key === `${TAG}-1`)?.why);
    line.includes("changed since") && !line.includes("I could do thing 1")
      ? ok(`and it says what changed rather than repeating the pitch: "${line}"`)
      : bad(`the returned line repeats the pitch: "${line}"`);

    console.log("");
    console.log("5. rewording is not changing its mind");
    /*
     * The fingerprint is over what it would DO, not over how it is described.
     * A scan that rewords its pitch has not changed its mind, and bringing a
     * declined suggestion back because the adjectives moved is nagging with
     * extra steps.
     */
    await decline(pool, `${TAG}-2`);
    const reworded = twenty.map((c) => c.key === `${TAG}-2`
      ? { ...c, title: "A completely different sentence", pitch: "Phrased another way entirely" }
      : c);
    const fourth = await recordScan(pool, reworded);
    fourth.stillDeclined.includes(`${TAG}-2`)
      ? ok("a reworded pitch with the same proposal stays declined")
      : bad("rewording brought a declined candidate back");
    fingerprint(cand(3)) === fingerprint({ ...cand(3), title: "x", pitch: "y" })
      ? ok("because the fingerprint is over the proposal, not over the prose")
      : bad("the fingerprint changes when the wording does");

    console.log("");
    console.log("6. approve one, and there is work");
    const taskId = await approve(pool, `${TAG}-3`, pid);
    taskId ? ok(`approving produced a task (${taskId.slice(0, 8)})`) : bad("approval produced no task");
    const task = (await pool.query<{ state: string; title: string }>(
      `SELECT state, title FROM tasks WHERE id = $1`, [taskId])).rows[0];
    task?.state === "queued"
      ? ok(`and it is queued, not merely recorded: "${task.title}"`)
      : bad(`the task is ${task?.state}`);
    const linked = (await pool.query<{ approved_task_id: string | null }>(
      `SELECT approved_task_id FROM improvement_candidates WHERE candidate_key = $1`, [`${TAG}-3`])).rows[0];
    linked?.approved_task_id === taskId
      ? ok("with the candidate pointing at the work it produced")
      : bad("the approval is not linked to its task");
    (await approve(pool, `${TAG}-3`, pid)) === null
      ? ok("and approving it twice does not make a second task")
      : bad("a double tap created two tasks");
  } finally {
    await pool.query(
      `DELETE FROM tasks WHERE id IN (SELECT approved_task_id FROM improvement_candidates
        WHERE candidate_key LIKE $1 AND approved_task_id IS NOT NULL)`, [`${TAG}-%`]);
    await pool.query(`DELETE FROM improvement_candidates WHERE candidate_key LIKE $1`, [`${TAG}-%`]);
    await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }

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
