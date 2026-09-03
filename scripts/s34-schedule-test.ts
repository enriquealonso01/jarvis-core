/**
 * S34 / L14 — overlap, misfire, failure pause, and no duplicate fire.
 *
 *   "L14: overlap skipped, misfire >15 min skipped with an Issue, three errors
 *    pause the schedule, restart causes no duplicate fire. **Assert there is
 *    exactly one scheduler**: with OpenClaw running, a due schedule fires once,
 *    and no `jarvis:` automation exists on the OpenClaw side to fire it a
 *    second time."
 *
 * The duplicate-fire assertion is the one worth being careful about, because
 * the obvious version cannot fail. Calling the decision twice and checking it
 * says "already ran" tests the SELECT; what actually protects a restart is the
 * unique index, and the way to test that is to race two inserts for the same
 * minute and assert exactly one wins.
 */
import { createPool } from "../src/db.js";
import {
  decideFire, DEFAULT_FAILURE_THRESHOLD, gatherContext, minuteOf, MISFIRE_GRACE_MS,
  noteMisfire, pauseForFailures, recordRun, type ScheduleRow,
} from "../src/schedule.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s34sch-${Math.random().toString(36).slice(2, 7)}`;
const AT = new Date("2026-09-04T03:00:00Z");

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const schedId = (await pool.query<{ id: string }>(
    `INSERT INTO schedules (project_id, name, cron, overlap)
     VALUES ($1,$2,'0 3 * * *','skip') RETURNING id`, [pid, `${SLUG} nightly`])).rows[0].id;
  const s: ScheduleRow = {
    id: schedId, name: `${SLUG} nightly`, projectId: pid,
    overlap: "skip", paused: false, failureThreshold: null,
  };
  const idle = { alreadyRan: false, activeTaskId: null, consecutiveFailures: 0 };

  try {
    console.log("1. due, and nothing in the way");
    decideFire(s, AT, AT, idle).fire ? ok("it fires") : bad("a due schedule did not fire");

    console.log("");
    console.log("2. overlap");
    const busy = { ...idle, activeTaskId: "00000000-0000-4000-8000-00000000beef" };
    const skipped = decideFire(s, AT, AT, busy);
    !skipped.fire && skipped.result === "skipped_overlap"
      ? ok(`with skip, a run still in flight means this window is dropped: "${skipped.why}"`)
      : bad(`overlap=skip did not skip: ${JSON.stringify(skipped)}`);
    const replaced = decideFire({ ...s, overlap: "replace" }, AT, AT, busy);
    replaced.fire && replaced.replaces === busy.activeTaskId
      ? ok("with replace, it fires and names the run it is replacing")
      : bad(`overlap=replace: ${JSON.stringify(replaced)}`);
    decideFire({ ...s, overlap: "parallel" }, AT, AT, busy).fire
      ? ok("and with parallel it simply fires alongside")
      : bad("overlap=parallel did not fire");

    console.log("");
    console.log("3. a missed window is missed, not caught up");
    const late = new Date(AT.getTime() + MISFIRE_GRACE_MS + 60_000);
    const missed = decideFire(s, AT, late, idle);
    !missed.fire && missed.result === "skipped_misfire"
      ? ok(`16 minutes late is a missed window: "${missed.why.slice(0, 80)}..."`)
      : bad(`a late fire was not treated as a misfire: ${JSON.stringify(missed)}`);
    /*
     * The boundary, because "late" and "missed" differ by a threshold and a
     * test that only checks 16 minutes would pass on a system with no grace
     * window at all.
     */
    decideFire(s, AT, new Date(AT.getTime() + MISFIRE_GRACE_MS - 1000), idle).fire
      ? ok("while 14 minutes late is still inside the grace window, and runs")
      : bad("a fire inside the grace window was treated as missed");
    await noteMisfire(pool, s, AT, MISFIRE_GRACE_MS + 60_000);
    const misfireIssue = (await pool.query<{ required_action: string }>(
      `SELECT required_action FROM issues WHERE dedupe_key = $1 AND status NOT IN ('resolved','ignored')`,
      [`schedule.missed:${schedId}`])).rows[0];
    misfireIssue?.required_action.includes("worse than having missed them")
      ? ok("and it raises an Issue saying why it did not catch up")
      : bad("no misfire Issue, or it does not explain itself");

    console.log("");
    console.log("4. three errors in a row pause it, visibly");
    const twice = decideFire(s, AT, AT, { ...idle, consecutiveFailures: 2 });
    twice.fire ? ok("two failures is not three: it still fires") : bad("it paused after two");
    const thrice = decideFire(s, AT, AT, { ...idle, consecutiveFailures: 3 });
    !thrice.fire && thrice.result === "paused"
      ? ok(`three in a row pauses it: "${thrice.why}"`)
      : bad(`three failures did not pause: ${JSON.stringify(thrice)}`);
    DEFAULT_FAILURE_THRESHOLD === 3 ? ok("the threshold is three") : bad(`the threshold is ${DEFAULT_FAILURE_THRESHOLD}`);
    await pauseForFailures(pool, s, 3);
    const paused = (await pool.query<{ paused: boolean }>(
      `SELECT paused FROM schedules WHERE id = $1`, [schedId])).rows[0];
    paused?.paused ? ok("the schedule is actually paused") : bad("the schedule was not paused");
    const pauseIssue = (await pool.query<{ title: string }>(
      `SELECT title FROM issues WHERE dedupe_key = $1 AND status NOT IN ('resolved','ignored')`,
      [`schedule.paused:${schedId}`])).rows[0];
    pauseIssue?.title.includes("paused itself")
      ? ok(`and it is visible as an Issue, not only as a column: "${pauseIssue.title}"`)
      : bad("a schedule paused itself silently");
    await pool.query(`UPDATE schedules SET paused = false WHERE id = $1`, [schedId]);

    console.log("");
    console.log("5. consecutive means consecutive");
    await recordRun(pool, { scheduleId: schedId, scheduledFor: new Date(AT.getTime() - 3 * 86400000), result: "error" });
    await recordRun(pool, { scheduleId: schedId, scheduledFor: new Date(AT.getTime() - 2 * 86400000), result: "fired" });
    await recordRun(pool, { scheduleId: schedId, scheduledFor: new Date(AT.getTime() - 86400000), result: "error" });
    const ctx = await gatherContext(pool, schedId, AT);
    ctx.consecutiveFailures === 1
      ? ok("error, success, error counts as one — a success in between resets it")
      : bad(`counted ${ctx.consecutiveFailures} consecutive failures across error/success/error`);

    console.log("");
    console.log("6. a restart cannot fire the same minute twice");
    const minute = minuteOf(new Date("2026-09-05T03:00:31Z"));
    /*
     * Raced, not sequenced. Checking that a second call returns "already ran"
     * only tests the SELECT; what protects a restart mid-loop is the unique
     * index, and the way to see it work is two inserts for the same minute
     * arriving together.
     */
    const both = await Promise.all([
      recordRun(pool, { scheduleId: schedId, scheduledFor: minute, result: "fired" }),
      recordRun(pool, { scheduleId: schedId, scheduledFor: minute, result: "fired" }),
    ]);
    both.filter(Boolean).length === 1
      ? ok("two simultaneous inserts for the same minute, and exactly one wins")
      : bad(`${both.filter(Boolean).length} of 2 inserts were accepted`);
    const rows = (await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM schedule_runs WHERE schedule_id = $1 AND scheduled_for = $2`,
      [schedId, minute.toISOString()])).rows[0];
    Number(rows.n) === 1
      ? ok("and one row exists, so the constraint is the guarantee rather than the check above it")
      : bad(`${rows.n} rows for one minute`);
    minuteOf(new Date("2026-09-05T03:00:59Z")).getTime() === minute.getTime()
      ? ok("the key is the minute, so any moment inside it is the same fire")
      : bad("the idempotency key is not the minute");

    console.log("");
    console.log("7. a skip leaves a row, or a stopped schedule looks like an idle one");
    const skipMinute = minuteOf(new Date("2026-09-06T03:00:00Z"));
    await recordRun(pool, { scheduleId: schedId, scheduledFor: skipMinute, result: "skipped_overlap" });
    const skipRow = (await pool.query<{ result: string }>(
      `SELECT result FROM schedule_runs WHERE schedule_id = $1 AND scheduled_for = $2`,
      [schedId, skipMinute.toISOString()])).rows[0];
    skipRow?.result === "skipped_overlap"
      ? ok("the skip is on the record with its reason")
      : bad("a skipped window left no trace");
  } finally {
    await pool.query(`DELETE FROM issues WHERE dedupe_key LIKE $1`, [`schedule.%:${schedId}`]);
    await pool.query(`DELETE FROM schedule_runs WHERE schedule_id = $1`, [schedId]);
    await pool.query(`DELETE FROM schedules WHERE id = $1`, [schedId]);
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
