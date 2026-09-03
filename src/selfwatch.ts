/**
 * Watching the watchdog (plan II.3, "Nobody is watching the watchdog").
 *
 * Every other fault in this system announces itself. This one announces
 * nothing: a stopped watchdog produces the same console a calm system produces,
 * while tasks sit in `running` forever. The evidence that it is working is the
 * absence of the events it would have raised.
 *
 * A second watchdog is not the answer, because it needs a third. The regress
 * stops at things that cannot themselves hang:
 *
 *  - the watchdog records each COMPLETED sweep, not a tick;
 *  - something ELSE reads that record, because a component must not be the sole
 *    author of its own liveness;
 *  - a host timer outside the container is the backstop, since it cannot be
 *    starved by whatever starved the watchdog.
 */
import type pg from "pg";

/** Written after the sweep returns. Before would record intent, not work. */
export async function recordSweep(
  pool: pg.Pool,
  component: string,
  owner: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO component_sweeps (component, last_completed_at, sweeps, owner, updated_at)
     VALUES ($1, now(), 1, $2, now())
     ON CONFLICT (component) DO UPDATE
        SET last_completed_at = now(),
            sweeps = component_sweeps.sweeps + 1,
            owner = EXCLUDED.owner,
            updated_at = now()`,
    [component, owner],
  );
}

export type SweepHealth = {
  component: string;
  lastCompletedAt: string | null;
  ageSeconds: number | null;
  sweeps: number;
  owner: string | null;
  stale: boolean;
  /** What a person should read, including when there is nothing to read. */
  detail: string;
};

/**
 * How a component looks to somebody else.
 *
 * `staleAfterSeconds` is several cycles rather than one: a single slow sweep is
 * not an incident, and raising on one would teach the reader to ignore this.
 *
 * A component that has NEVER recorded a sweep is stale, not unknown. VII.1:
 * absence of data must never render as absence of problems - and this is the
 * exact shape that rule exists for, because a watchdog that never started looks
 * identical to one that has nothing to report.
 */
export async function sweepHealth(
  pool: pg.Pool,
  component: string,
  staleAfterSeconds = 300,
): Promise<SweepHealth> {
  const r = await pool.query<{
    last_completed_at: string; age: string; sweeps: string; owner: string | null;
  }>(
    `SELECT last_completed_at::text,
            extract(epoch FROM (now() - last_completed_at))::int::text AS age,
            sweeps::text, owner
       FROM component_sweeps WHERE component = $1`,
    [component],
  );
  const row = r.rows[0];
  if (!row) {
    return {
      component,
      lastCompletedAt: null,
      ageSeconds: null,
      sweeps: 0,
      owner: null,
      stale: true,
      detail: `${component} has never recorded a completed sweep`,
    };
  }
  const age = Number(row.age);
  const stale = age > staleAfterSeconds;
  return {
    component,
    lastCompletedAt: row.last_completed_at,
    ageSeconds: age,
    sweeps: Number(row.sweeps),
    owner: row.owner,
    stale,
    detail: stale
      ? `${component} last completed a sweep ${age}s ago, over the ${staleAfterSeconds}s limit`
      : `${component} completed a sweep ${age}s ago`,
  };
}

/**
 * Raise or clear the incident, from wherever is doing the reading.
 *
 * Deliberately idempotent and callable from more than one place: the API
 * renders it, and a host timer outside the container raises it too. Two
 * independent readers of the same fact is the point - one of them may be inside
 * whatever went wrong.
 */
export async function reconcileSweepIncident(
  pool: pg.Pool,
  health: SweepHealth,
  reporter: string,
): Promise<"opened" | "closed" | "unchanged"> {
  const open = await pool.query<{ id: string }>(
    `SELECT id FROM health_incidents
      WHERE service = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    [health.component],
  );

  if (health.stale && !open.rows[0]) {
    await pool.query(
      `INSERT INTO health_incidents (service, severity, opened_at, summary)
       VALUES ($1, 'high', now(), $2)`,
      [health.component, `${health.detail} (noticed by ${reporter})`],
    );
    return "opened";
  }
  if (!health.stale && open.rows[0]) {
    await pool.query(
      `UPDATE health_incidents SET closed_at = now(),
              summary = summary || ' - resolved: ' || $2
        WHERE id = $1`,
      [open.rows[0].id, health.detail],
    );
    return "closed";
  }
  return "unchanged";
}

/**
 * The window nobody was watching, written down.
 *
 * A watchdog that restarts must reconcile the time it missed rather than
 * beginning at zero. Otherwise forty unwatched minutes render as forty healthy
 * ones and the recovery story reads as though it worked.
 *
 * Returns the gap in seconds when there was one worth recording.
 */
export async function recordBlindWindow(
  pool: pg.Pool,
  component: string,
  owner: string,
  minSeconds = 120,
): Promise<number | null> {
  const prior = await sweepHealth(pool, component, minSeconds);
  if (prior.ageSeconds === null || prior.ageSeconds < minSeconds) return null;

  await pool.query(
    `INSERT INTO health_incidents (service, severity, opened_at, closed_at, summary)
     VALUES ($1, 'medium', now(), now(), $2)`,
    [
      component,
      `blind window: no ${component} sweep completed for ${prior.ageSeconds}s before ${owner} took over`,
    ],
  );
  return prior.ageSeconds;
}

/**
 * Leases held by a worker that died during the blind window.
 *
 * On this hardware one held lease in the heavy lane is the entire lane, so a
 * lease nobody released is not a tidiness problem. Only EXPIRED leases are
 * touched: an expiry is already the system's own statement that the holder is
 * gone, and clearing a live one would take a task away from a process still
 * working on it.
 */
export async function reconcileExpiredLeases(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    `UPDATE tasks SET lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE lease_until IS NOT NULL AND lease_until < now()
        AND state IN ('preparing', 'running')
      RETURNING id`,
  );
  return r.rowCount ?? 0;
}
