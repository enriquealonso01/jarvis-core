import type pg from "pg";

/**
 * Plan §41: task detail shows "active, elapsed, waiting, and paused time".
 *
 * Derived from `task_transitions` rather than stored counters, so it cannot
 * drift from the state machine and works retroactively for tasks that ran
 * before this existed.
 */
export type TaskTiming = {
  elapsed_seconds: number;
  active_seconds: number;
  waiting_seconds: number;
  paused_seconds: number;
  /** Still running: the figures include time up to now. */
  in_progress: boolean;
};

/** Which bucket a state's *duration* counts towards. */
function bucketFor(state: string): "active" | "waiting" | "paused" | "none" {
  if (["running", "preparing", "recovering", "waiting_for_tool"].includes(state)) return "active";
  if (state.startsWith("waiting_") || ["queued", "stalled", "retry_scheduled"].includes(state)) {
    return "waiting";
  }
  if (state === "paused") return "paused";
  return "none";
}

const TERMINAL = new Set(["succeeded", "failed_terminal", "cancelled"]);

export async function taskTiming(pool: pg.Pool, taskId: string): Promise<TaskTiming | null> {
  const r = await pool.query<{ to_state: string; at: string }>(
    `SELECT to_state, at FROM task_transitions WHERE task_id = $1 ORDER BY at`,
    [taskId],
  );
  if (!r.rows.length) return null;

  const created = await pool.query<{ created_at: string }>(
    `SELECT created_at FROM tasks WHERE id = $1`,
    [taskId],
  );
  const startedAt = new Date(created.rows[0]?.created_at ?? r.rows[0].at).getTime();

  let active = 0;
  let waiting = 0;
  let paused = 0;
  let inProgress = true;

  for (let i = 0; i < r.rows.length; i++) {
    const state = r.rows[i].to_state;
    const from = new Date(r.rows[i].at).getTime();

    if (TERMINAL.has(state)) {
      inProgress = false;
      // A terminal state has no duration; stop accumulating here.
      break;
    }

    const to = i + 1 < r.rows.length ? new Date(r.rows[i + 1].at).getTime() : Date.now();
    const seconds = Math.max(0, (to - from) / 1000);

    switch (bucketFor(state)) {
      case "active":
        active += seconds;
        break;
      case "waiting":
        waiting += seconds;
        break;
      case "paused":
        paused += seconds;
        break;
      default:
        break;
    }
  }

  const endAt = inProgress
    ? Date.now()
    : new Date(r.rows.find((x) => TERMINAL.has(x.to_state))?.at ?? Date.now()).getTime();

  return {
    elapsed_seconds: Math.round(Math.max(0, (endAt - startedAt) / 1000)),
    active_seconds: Math.round(active),
    waiting_seconds: Math.round(waiting),
    paused_seconds: Math.round(paused),
    in_progress: inProgress,
  };
}
