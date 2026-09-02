import type pg from "pg";

/**
 * Remove a fixture project and everything it leaked.
 *
 * The S28 parity suite had no teardown at all: it printed the repository URL
 * and exited. Every run therefore left a project row, a deploy key, an API
 * credential and - the part that mattered - Issues sitting in the queue, asking
 * Enrique to read a review of a throwaway repository. Three of the five things
 * waiting on him were that.
 *
 * The delete list is DERIVED, not written down. Twenty-four tables reference
 * `projects` today; a hand-maintained list is one migration away from being
 * wrong, and a teardown that half-works leaks silently. So the referencing
 * tables are read from the catalog, and afterwards the same catalog is used to
 * assert that nothing anywhere still points at the project. A new table added
 * next month makes that assertion fail loudly instead of quietly leaving rows.
 *
 * GitHub repositories are deliberately NOT deleted here. Deleting a repository
 * is irreversible and is Enrique's call; the teardown reports what it would
 * have removed and leaves it standing.
 */

/** Children of `tasks`, which must go before the tasks themselves. */
const TASK_CHILDREN = ["task_transitions", "task_events", "task_attempts", "task_context"];

async function referencingTables(pool: pg.Pool): Promise<{ table: string; column: string }[]> {
  const r = await pool.query<{ table: string; column: string }>(
    `SELECT tc.table_name AS table, kcu.column_name AS column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'projects'`,
  );
  return r.rows;
}

export type Teardown = {
  removed: Record<string, number>;
  /** Tables that still reference the project. Empty when the teardown worked. */
  leftBehind: { table: string; column: string; rows: number }[];
};

export async function teardownFixtureProject(
  pool: pg.Pool,
  projectId: string,
): Promise<Teardown> {
  const removed: Record<string, number> = {};
  const count = (t: string, n: number | null) => { if (n) removed[t] = (removed[t] ?? 0) + n; };

  const tasks = await pool.query<{ id: string }>(
    `SELECT id FROM tasks WHERE project_id = $1`, [projectId],
  );
  const taskIds = tasks.rows.map((t) => t.id);
  if (taskIds.length) {
    for (const child of TASK_CHILDREN) {
      const r = await pool.query(`DELETE FROM ${child} WHERE task_id = ANY($1)`, [taskIds])
        .catch(() => null);
      count(child, r?.rowCount ?? 0);
    }
  }

  const refs = await referencingTables(pool);
  for (const ref of refs) {
    const r = await pool
      .query(`DELETE FROM ${ref.table} WHERE ${ref.column} = $1`, [projectId])
      .catch(() => null);
    count(ref.table, r?.rowCount ?? 0);
  }
  const self = await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  count("projects", self.rowCount);

  /*
   * Prove it, from the same catalog. A teardown that says it worked because it
   * ran without throwing is the same class of claim as a test that passes
   * because it asserted nothing.
   */
  const leftBehind: Teardown["leftBehind"] = [];
  for (const ref of refs) {
    const r = await pool
      .query<{ n: string }>(`SELECT count(*) AS n FROM ${ref.table} WHERE ${ref.column} = $1`,
        [projectId])
      .catch(() => null);
    const n = Number(r?.rows[0]?.n ?? 0);
    if (n > 0) leftBehind.push({ table: ref.table, column: ref.column, rows: n });
  }
  return { removed, leftBehind };
}
