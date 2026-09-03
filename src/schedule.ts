/**
 * Deciding whether a schedule fires (plan S34, L14).
 *
 * ONE SCHEDULER, AND IT IS JARVIS'S. `OPENCLAW_INTEGRATION.md` specified a sync
 * worker mirroring `schedules` into OpenClaw automations which would fire a
 * webhook back - and the worker already fires them itself, from Postgres, on
 * its own loop. Building both "would mean two schedulers firing the same
 * schedule, which is precisely the duplicate-fire bug L14 exists to catch,
 * installed deliberately." The plan supersedes that section; this file is the
 * only thing that decides a fire.
 *
 * The decision is pulled out of the worker loop and made pure so it can be
 * tested at any clock, in any state, without a running worker - the loop then
 * has nothing in it but I/O. Four things it has to get right, each of which is
 * a way a schedule misbehaves silently:
 *
 *  - **A missed window is not caught up.** A box that was off for six hours
 *    comes back and fires nothing that was due in them; it fires what is due
 *    now. Catching up looks like diligence and is how a nightly deploy runs six
 *    times at breakfast.
 *  - **An overlapping run is decided by policy, not by luck of timing.**
 *  - **Three errors in a row pause it, visibly.** The plan: "a schedule that
 *    silently stops has usually hit its error count and paused itself - that is
 *    correct behaviour, but it must be visible in the console rather than only
 *    in a column."
 *  - **A skip is recorded.** A schedule that never runs and one that was never
 *    due look identical unless the skip left a row.
 */
import type pg from "pg";

/** Later than this and the window is missed rather than late. */
export const MISFIRE_GRACE_MS = 15 * 60 * 1000;

/** Consecutive errors before a schedule pauses itself. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

export type Overlap = "queue" | "skip" | "replace" | "parallel";

export type ScheduleRow = {
  id: string;
  name: string;
  projectId: string;
  overlap: Overlap;
  paused: boolean;
  failureThreshold: number | null;
};

/** What the decision needs to know about the world, gathered once. */
export type FireContext = {
  /** A run already recorded for this exact minute. */
  alreadyRan: boolean;
  /** A task from this schedule still going. */
  activeTaskId: string | null;
  /** How many of the most recent runs errored, consecutively. */
  consecutiveFailures: number;
};

export type FireDecision =
  | { fire: true; replaces: string | null; why: string }
  | { fire: false; result: "skipped_overlap" | "skipped_misfire" | "already_ran" | "paused"; why: string };

/**
 * Should this schedule fire for this minute?
 *
 * Pure. Every input is a value, so the awkward cases - a box that was off for
 * six hours, a run still going from yesterday, a schedule that has failed twice
 * and is about to fail again - are a line of test rather than a live rehearsal.
 */
export function decideFire(
  s: ScheduleRow,
  scheduledFor: Date,
  now: Date,
  ctx: FireContext,
): FireDecision {
  if (s.paused) {
    return { fire: false, result: "paused", why: `${s.name} is paused` };
  }
  if (ctx.alreadyRan) {
    /*
     * The restart case. Keyed on the MINUTE rather than on "did we run
     * recently", which is what makes a restart mid-loop harmless: the same
     * minute produces the same key and the second attempt is a no-op.
     */
    return { fire: false, result: "already_ran", why: `${s.name} already ran for ${scheduledFor.toISOString()}` };
  }

  const lateBy = now.getTime() - scheduledFor.getTime();
  if (lateBy > MISFIRE_GRACE_MS) {
    /*
     * Missed, not late. The alternative - catching up - is how a box that was
     * off overnight fires eight hours of hourly schedules in one minute, which
     * is worse than having missed them, because it happens all at once and
     * unattended.
     */
    return {
      fire: false,
      result: "skipped_misfire",
      why: `${s.name} was due at ${scheduledFor.toISOString()}, ${Math.round(lateBy / 60000)} minutes ago — `
        + "past the grace window, so the window is missed rather than run late",
    };
  }

  if (ctx.activeTaskId) {
    switch (s.overlap) {
      case "skip":
        return { fire: false, result: "skipped_overlap", why: `${s.name} is still running from its last fire` };
      case "replace":
        return { fire: true, replaces: ctx.activeTaskId, why: "replacing the run still in flight" };
      case "queue":
      case "parallel":
        // `queue` differs from `parallel` in the lane, not here: both start a
        // task, and the queue decides whether it waits.
        return { fire: true, replaces: null, why: `${s.overlap} alongside the run in flight` };
    }
  }

  const threshold = s.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  if (ctx.consecutiveFailures >= threshold) {
    return {
      fire: false,
      result: "paused",
      why: `${s.name} has failed ${ctx.consecutiveFailures} times in a row and has paused itself`,
    };
  }

  return { fire: true, replaces: null, why: "due" };
}

/** The minute a schedule is being considered for, with seconds discarded. */
export function minuteOf(now: Date): Date {
  const m = new Date(now);
  m.setSeconds(0, 0);
  return m;
}

export async function gatherContext(
  pool: pg.Pool,
  scheduleId: string,
  scheduledFor: Date,
  threshold = DEFAULT_FAILURE_THRESHOLD,
): Promise<FireContext> {
  const ran = await pool.query(
    `SELECT 1 FROM schedule_runs WHERE schedule_id = $1 AND scheduled_for = $2`,
    [scheduleId, scheduledFor.toISOString()]);
  const active = await pool.query<{ task_id: string }>(
    `SELECT r.task_id FROM schedule_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.schedule_id = $1 AND t.state IN ('queued','preparing','running','recovering')
      LIMIT 1`,
    [scheduleId]);
  /*
   * Consecutive failures read from the run history rather than kept in a
   * column. Derived beats maintained for the same reason as S31's classified
   * hash: a counter has to be reset by whoever succeeds, and the day somebody
   * adds a success path that forgets is the day a healthy schedule stays
   * paused.
   */
  const recent = await pool.query<{ result: string | null }>(
    `SELECT result FROM schedule_runs
      WHERE schedule_id = $1 AND result IN ('fired', 'error')
      ORDER BY scheduled_for DESC NULLS LAST LIMIT $2`,
    [scheduleId, threshold]);
  let consecutiveFailures = 0;
  for (const r of recent.rows) {
    if (r.result === "error") consecutiveFailures += 1;
    else break;
  }
  return {
    alreadyRan: (ran.rowCount ?? 0) > 0,
    activeTaskId: active.rows[0]?.task_id ?? null,
    consecutiveFailures,
  };
}

/**
 * Write down what happened, including the skips.
 *
 * A skip that leaves no row makes a schedule that never runs indistinguishable
 * from one that was never due - which is exactly the question somebody asks
 * when a nightly job has quietly stopped.
 *
 * `ON CONFLICT DO NOTHING` against the unique index rather than a check before
 * the insert: the constraint is what makes a restart mid-loop harmless, and a
 * second SELECT would only narrow the window rather than close it.
 */
export async function recordRun(
  pool: pg.Pool,
  args: { scheduleId: string; scheduledFor: Date; taskId?: string | null; result: string },
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO schedule_runs (schedule_id, task_id, scheduled_for, started_at, result)
     VALUES ($1,$2,$3, now(), $4)
     ON CONFLICT (schedule_id, scheduled_for) WHERE scheduled_for IS NOT NULL DO NOTHING`,
    [args.scheduleId, args.taskId ?? null, args.scheduledFor.toISOString(), args.result]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Pause a schedule that keeps failing, and say so somewhere he will see.
 *
 * The Issue is the point. "A schedule that silently stops has usually hit its
 * error count and paused itself — that is correct behaviour, but it must be
 * visible in the console rather than only in a column."
 */
export async function pauseForFailures(
  pool: pg.Pool,
  s: ScheduleRow,
  failures: number,
): Promise<void> {
  await pool.query(`UPDATE schedules SET paused = true WHERE id = $1`, [s.id]);
  const { raiseIssue } = await import("./notify.js");
  await raiseIssue(pool, {
    category: "schedule.paused",
    title: `[schedule] ${s.name} paused itself after ${failures} failures in a row`,
    dedupeKey: `schedule.paused:${s.id}`,
    projectId: s.projectId,
    owner: "user",
    evidence: { schedule: s.name, consecutive_failures: failures },
    requiredAction:
      `${s.name} has stopped running. Fix what it is failing on, then un-pause it on the schedule's page. `
      + "It paused rather than continuing so a broken job does not fail silently every night.",
  });
}

/** The misfire Issue: a window was missed, and that is worth one line. */
export async function noteMisfire(
  pool: pg.Pool,
  s: ScheduleRow,
  scheduledFor: Date,
  lateByMs: number,
): Promise<void> {
  const { raiseIssue } = await import("./notify.js");
  await raiseIssue(pool, {
    category: "schedule.missed",
    title: `[schedule] ${s.name} missed its window`,
    dedupeKey: `schedule.missed:${s.id}`,
    projectId: s.projectId,
    owner: "jarvis",
    evidence: {
      schedule: s.name,
      due_at: scheduledFor.toISOString(),
      late_by_minutes: Math.round(lateByMs / 60000),
    },
    requiredAction:
      "Nothing, unless it keeps happening. The window was skipped rather than caught up, "
      + "because running a night of missed schedules at breakfast is worse than having missed them.",
  });
}
