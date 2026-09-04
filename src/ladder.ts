import type pg from "pg";
import { transitionTask } from "./jobs.js";
import { raiseIssue } from "./notify.js";

/**
 * The recovery ladder (plan II.3, retrofitted in S18b).
 *
 * "Recovery escalates from cheapest to most expensive, and stops at the first
 * rung that works. Jumping straight to a worker restart turns a two-second
 * network blip into a lost quarter-hour."
 *
 * Before this, recovery was ONE action: stalled -> recovering -> queued, every
 * time, whatever had gone wrong. That is rung 7 — resume from checkpoint with a
 * fresh worker — applied to a two-second blip and to a model that cannot do the
 * job alike, and it can neither be cheaper than itself nor escalate past itself.
 *
 * Each rung is recorded on the task, so the timeline shows WHAT WAS TRIED rather
 * than a bare "recovered". Each has its own limit, and the ladder as a whole
 * ends at rung 10 — "a ladder without limits is exactly how an infinite retry
 * loop is built".
 *
 * TWO RUNGS ARE NOT AVAILABLE YET and say so rather than pretending. Rung 4
 * resets a tool or browser, and there is no browser worker to reset; rung 9
 * switches harness, which the plan itself notes is "S28's runtime interface is
 * what makes this possible" — S28 is not built. An unavailable rung is skipped
 * with its reason recorded, not silently counted as tried.
 */

export type RungOutcome = {
  rung: number;
  name: string;
  applied: boolean;
  detail: string;
};

export type Rung = {
  n: number;
  name: string;
  /** How many times this rung may be tried for one task before escalating. */
  limit: number;
  /** Seconds to wait before the next attempt after this rung is used. */
  backoffSeconds: number;
};

export const RUNGS: Rung[] = [
  { n: 1, name: "wait", limit: 2, backoffSeconds: 30 },
  { n: 2, name: "nudge", limit: 1, backoffSeconds: 15 },
  { n: 3, name: "retry", limit: 2, backoffSeconds: 15 },
  { n: 4, name: "reset_tool", limit: 1, backoffSeconds: 10 },
  { n: 5, name: "restart_worker", limit: 1, backoffSeconds: 10 },
  { n: 6, name: "restart_session", limit: 1, backoffSeconds: 10 },
  { n: 7, name: "resume_from_checkpoint", limit: 2, backoffSeconds: 10 },
  { n: 8, name: "switch_model", limit: 1, backoffSeconds: 5 },
  { n: 9, name: "switch_harness", limit: 1, backoffSeconds: 5 },
  { n: 10, name: "ask_enrique", limit: 1, backoffSeconds: 0 },
];

/** How long a rung asks for before the next one is tried. */
export function backoffSecondsFor(name: string): number {
  return RUNGS.find((r) => r.name === name)?.backoffSeconds ?? 30;
}

/** What has already been tried for this task, by rung name. */
async function tried(pool: pg.Pool, taskId: string): Promise<Map<string, number>> {
  const r = await pool.query<{ name: string; n: string }>(
    `SELECT name, count(*)::text AS n FROM task_events
     WHERE task_id = $1 AND type = 'recovery' AND name IS NOT NULL
     GROUP BY name`,
    [taskId],
  );
  return new Map(r.rows.map((row) => [row.name, Number(row.n)]));
}

async function record(pool: pg.Pool, taskId: string, out: RungOutcome): Promise<void> {
  await pool
    .query(
      `INSERT INTO task_events (task_id, type, name, summary)
       VALUES ($1, 'recovery', $2, $3)`,
      [taskId, out.name, `rung ${out.rung}: ${out.detail}`.slice(0, 500)],
    )
    .catch(() => undefined);
}

/**
 * Climb one rung.
 *
 * Called each time recovery is needed for a task. It picks the cheapest rung
 * not yet exhausted, applies it, records it, and returns what it did. It does
 * NOT loop through the ladder in one pass: whether a rung worked is only
 * knowable by letting the task run again, so each call is one step and the next
 * failure is what escalates.
 */
export async function climb(
  pool: pg.Pool,
  taskId: string,
  cause: string,
): Promise<RungOutcome> {
  const used = await tried(pool, taskId);

  for (const rung of RUNGS) {
    if ((used.get(rung.name) ?? 0) >= rung.limit) continue;

    const out = await apply(pool, taskId, rung, cause);
    await record(pool, taskId, out);

    // An unavailable rung is recorded and then stepped past in the same pass:
    // it costs nothing to skip and waiting a whole failure cycle to discover
    // there is no browser to reset would be the ladder wasting the time it
    // exists to save.
    if (!out.applied) {
      used.set(rung.name, rung.limit);
      continue;
    }
    return out;
  }

  // Every rung exhausted. This is rung 10's job and it has already run, but a
  // task that gets here anyway must not be left in `recovering` forever.
  const out: RungOutcome = {
    rung: 10,
    name: "ask_enrique",
    applied: true,
    detail: "every rung has been tried",
  };
  await askEnrique(pool, taskId, "every rung of the recovery ladder has been tried");
  await record(pool, taskId, out);
  return out;
}

async function apply(
  pool: pg.Pool,
  taskId: string,
  rung: Rung,
  cause: string,
): Promise<RungOutcome> {
  const done = (detail: string): RungOutcome =>
    ({ rung: rung.n, name: rung.name, applied: true, detail });
  const skip = (detail: string): RungOutcome =>
    ({ rung: rung.n, name: rung.name, applied: false, detail });

  switch (rung.name) {
    case "wait":
      /*
       * "Most stalls resolve themselves." Do nothing except hold the task out of
       * the queue for the backoff — if the worker was merely slow it will beat
       * again and nothing else is needed.
       */
      await pool.query(
        `UPDATE tasks SET state = 'recovering', waiting_reason = $2,
                lease_until = now() + make_interval(secs => $3)
         WHERE id = $1`,
        [taskId, `waiting ${rung.backoffSeconds}s to see if it resolves itself`, rung.backoffSeconds],
      );
      return done(`waiting ${rung.backoffSeconds}s`);

    case "nudge": {
      /*
       * Re-prompt the agent with its own last progress event. A stalled harness
       * cannot be spoken to directly, so the nudge is delivered the way every
       * other mid-run instruction is: as task context, which the next run reads
       * at its first checkpoint.
       */
      const last = await pool.query<{ name: string | null; summary: string | null }>(
        `SELECT name, summary FROM task_events
         WHERE task_id = $1 AND type IN ('tool', 'phase')
         ORDER BY at DESC LIMIT 1`,
        [taskId],
      );
      const l = last.rows[0];
      if (!l) return skip("nothing to nudge it with — no progress was recorded");
      await pool.query(
        `INSERT INTO task_context (task_id, body, attached_state)
         VALUES ($1, $2, 'recovering')`,
        [
          taskId,
          `You stopped after: ${l.name ?? "?"} — ${l.summary ?? ""}. `
          + "Carry on from there rather than starting again.",
        ],
      );
      await requeue(pool, taskId, `nudged with its own last progress: ${l.name}`, rung);
      return done(`nudged with ${l.name}`);
    }

    case "retry":
      await requeue(pool, taskId, cause, rung);
      return done("retried the operation as it was");

    case "reset_tool":
      // No browser worker exists to reset (II.2b lists it as future work), so
      // there is nothing here to do. Recorded rather than skipped silently.
      return skip("no browser or tool worker on this box to reset");

    case "restart_worker":
      /*
       * From the task's point of view a worker restart is exactly this: the
       * lease is released so a DIFFERENT process claims it. Killing the worker
       * itself would also drop every other task it holds, which is more
       * expensive than the rung is supposed to be.
       */
      await pool.query(
        `UPDATE tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1`,
        [taskId],
      );
      await requeue(pool, taskId, "released for a different worker", rung);
      return done("released the lease so another worker takes it");

    case "restart_session":
      // Start a fresh harness session rather than resuming the old one: a
      // session whose context is the problem cannot fix itself by continuing.
      await pool.query(`UPDATE tasks SET external_session_id = NULL WHERE id = $1`, [taskId]);
      await requeue(pool, taskId, "starting a fresh harness session", rung);
      return done("cleared the harness session id");

    case "resume_from_checkpoint": {
      const cp = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM task_checkpoints WHERE task_id = $1 ORDER BY at DESC LIMIT 1`,
        [taskId],
      );
      const has = Boolean(cp.rows[0]);
      await requeue(
        pool,
        taskId,
        has ? "resuming from the latest checkpoint" : "requeued with no checkpoint to resume from",
        rung,
      );
      return done(has ? "resumed from the latest checkpoint" : "requeued (no checkpoint existed)");
    }

    case "switch_model": {
      /*
       * "A task blocked by a MODEL'S inability rather than a system fault can
       * still finish." Move to the next approved route for the task's role,
       * within the pool — never outside it, because the pool is what the policy
       * engine approved.
       */
      const current = await pool.query<{ auth_profile_id: string | null; model_role: string | null }>(
        "SELECT auth_profile_id, model_role FROM tasks WHERE id = $1",
        [taskId],
      );
      const role = current.rows[0]?.model_role ?? "senior_engineer";
      const from = current.rows[0]?.auth_profile_id ?? null;
      /*
       * Upward, into the escalation pool - never sideways.
       *
       * This used to take any other approved route for the role, ordered by
       * route_order, which is a LATERAL move: it re-runs the same failure at
       * the same price and eventually succeeds often enough to look like it
       * worked. Escalation is what failure purchases, so the only routes
       * eligible here are the ones a measurement put in the escalation pool.
       */
      const alt = await pool.query<{ auth_profile_id: string }>(
        `SELECT auth_profile_id FROM model_registry
         WHERE approval_state = 'approved' AND health IN ('healthy','degraded')
           AND auth_profile_id IS NOT NULL
           AND pool = 'escalation'
           AND $1 = ANY (role_assignments)
           AND auth_profile_id IS DISTINCT FROM $2
         ORDER BY route_order LIMIT 1`,
        [role, from],
      );
      const next = alt.rows[0]?.auth_profile_id;
      /*
       * An empty escalation pool is a valid configuration, not a fault. It
       * skips to the next rung rather than pretending to have escalated.
       */
      if (!next) return skip(`no escalation route for the ${role} role`);
      await pool.query("UPDATE tasks SET auth_profile_id = $2 WHERE id = $1", [taskId, next]);
      /*
       * Recorded so a shape that escalates every time is visible without anyone
       * reading a log - that belongs in the weekly Improvement review, and a
       * permanent escalation is a pool assignment that is wrong.
       */
      await pool.query(
        `INSERT INTO escalations (task_id, shape, from_profile, to_profile, cause)
         VALUES ($1, $2, $3, $4, $5)`,
        [taskId, role, from, next, cause.slice(0, 300)],
      ).catch((err) => console.error("escalation not recorded:", err instanceof Error ? err.message : err));
      await requeue(pool, taskId, `escalated to ${next}`, rung);
      return done(`escalated to ${next}`);
    }

    case "switch_harness":
      // The plan says this outright: "S28's runtime interface is what makes this
      // possible". There is one harness behind one spawn call today, so there is
      // nothing to switch to.
      return skip("only one harness runtime exists (S28's interface is not built)");

    case "ask_enrique":
      await askEnrique(pool, taskId, cause);
      return done("parked for Enrique");

    default:
      return skip("unknown rung");
  }
}

async function requeue(pool: pg.Pool, taskId: string, cause: string, rung: Rung): Promise<void> {
  await pool.query(`UPDATE tasks SET waiting_reason = NULL WHERE id = $1`, [taskId]);
  /*
   * The backoff travels WITH the state change rather than in a statement before
   * it.
   *
   * `transitionTask` now releases the lease on the way out of the running
   * family — including `lease_until` — so a cooling-off period written first was
   * wiped a moment later. Every rung's backoff silently became zero and the task
   * went straight back into the queue, which is the busy-loop the ladder exists
   * to prevent.
   *
   * The backoff is a lease EXPIRY held into the future, which the claim query
   * already respects, so a rung's cooling-off period needs no scheduler of its
   * own. It sets the expiry only: the owner is released by leaving, which is not
   * this function's to describe.
   *
   * Coerced through Number and rendered inline because extraSet carries no
   * parameters; the value comes from the rung table, never from input.
   */
  const backoff = Number(rung.backoffSeconds) || 0;
  await transitionTask(
    pool, taskId, "queued", `recovery rung ${rung.n} (${rung.name}): ${cause}`, "watchdog",
    backoff > 0 ? `lease_until = now() + make_interval(secs => ${backoff})` : "",
  );
}

async function askEnrique(pool: pg.Pool, taskId: string, cause: string): Promise<void> {
  const t = await pool.query<{ title: string; project_id: string | null }>(
    "SELECT title, project_id FROM tasks WHERE id = $1",
    [taskId],
  );
  const row = t.rows[0];
  await transitionTask(
    pool,
    taskId,
    "waiting_for_user",
    "the recovery ladder ran out of rungs",
    "watchdog",
  );
  const attempted = await pool.query<{ name: string; summary: string }>(
    `SELECT name, summary FROM task_events
     WHERE task_id = $1 AND type = 'recovery' ORDER BY at`,
    [taskId],
  );
  await raiseIssue(pool, {
    category: "worker.crash",
    service: "watchdog",
    owner: "user",
    status: "waiting_for_user",
    title: `[recovery] ${(row?.title ?? "a task").slice(0, 70)} could not be recovered`,
    dedupeKey: `recovery.exhausted:${taskId}`,
    taskId,
    projectId: row?.project_id ?? null,
    evidence: {
      cause,
      // The whole ladder, in order, so the ticket says what was tried rather
      // than "recovery failed".
      rungs_tried: attempted.rows.map((r) => `${r.name}: ${r.summary}`),
    },
    requiredAction:
      "Every automatic recovery has been tried and recorded above. Read the transcript and the "
      + "rungs that were attempted before retrying by hand.",
  }).catch(() => undefined);
}

/** For the console and the tests: what has been tried, in order. */
export async function rungsTried(
  pool: pg.Pool,
  taskId: string,
): Promise<{ name: string; summary: string; at: string }[]> {
  const r = await pool.query<{ name: string; summary: string; at: string }>(
    `SELECT name, summary, at::text AS at FROM task_events
     WHERE task_id = $1 AND type = 'recovery' ORDER BY at, id`,
    [taskId],
  );
  return r.rows;
}
