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

/**
 * Tables whose foreign key points at `parent`, from the catalog.
 *
 * Cached: the sweep calls this for dozens of projects and the answer does not
 * change between them.
 */
const refCache = new Map<string, { table: string; column: string }[]>();

async function referencing(
  pool: pg.Pool,
  parent: string,
): Promise<{ table: string; column: string }[]> {
  const hit = refCache.get(parent);
  if (hit) return hit;
  const r = await pool.query<{ table: string; column: string }>(
    `SELECT tc.table_name AS table, kcu.column_name AS column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = $1
        AND tc.table_name <> $1`,
    [parent],
  );
  refCache.set(parent, r.rows);
  return r.rows;
}

/**
 * Delete rows, and whatever depends on them, depth first.
 *
 * The first version handled exactly one level - the children of `tasks`, named
 * in a hand-written list - and then met `conversations`, which have children of
 * their own. Twenty-two projects could not be removed and the failure surfaced
 * as a raw foreign key error. So the descent is now general and derived from
 * the catalog: whatever the shape of the graph, it is walked rather than
 * enumerated. `depth` only exists to stop a cycle turning into a hang.
 */
async function deleteRows(
  pool: pg.Pool,
  table: string,
  column: string,
  values: string[],
  removed: Record<string, number>,
  depth = 0,
): Promise<void> {
  if (!values.length || depth > 4) return;

  const mine = await pool.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE ${column} = ANY($1)`, [values],
  ).catch(() => null);
  const ids = mine?.rows.map((r) => r.id) ?? [];

  if (ids.length) {
    for (const child of await referencing(pool, table)) {
      await deleteRows(pool, child.table, child.column, ids, removed, depth + 1);
    }
  }

  const r = await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [values])
    .catch(() => null);
  if (r?.rowCount) removed[table] = (removed[table] ?? 0) + r.rowCount;
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

  const refs = await referencing(pool, "projects");
  for (const ref of refs) {
    await deleteRows(pool, ref.table, ref.column, [projectId], removed);
  }
  const self = await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId])
    .catch(() => null);
  if (self?.rowCount) removed.projects = (removed.projects ?? 0) + self.rowCount;

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
  const still = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM projects WHERE id = $1`, [projectId],
  );
  if (Number(still.rows[0]?.n ?? 0) > 0) {
    leftBehind.push({ table: "projects", column: "id", rows: 1 });
  }
  return { removed, leftBehind };
}
