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


const idColumns = new Map<string, boolean>();

/** Does this table have an `id` column to recurse on? Asked once per table. */
async function hasIdColumn(pool: pg.Pool, table: string): Promise<boolean> {
  const hit = idColumns.get(table);
  if (hit !== undefined) return hit;
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = 'id'`, [table]);
  const has = Number(r.rows[0]?.n ?? 0) > 0;
  idColumns.set(table, has);
  return has;
}

/** Whether a column may be set to NULL - how a cycle is broken safely. */
const nullableCache = new Map<string, boolean>();

async function isNullable(pool: pg.Pool, table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const hit = nullableCache.get(key);
  if (hit !== undefined) return hit;
  const r = await pool.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`, [table, column]);
  const nullable = r.rows[0]?.is_nullable === "YES";
  nullableCache.set(key, nullable);
  return nullable;
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
  path: string[] = [],
): Promise<void> {
  if (!values.length) return;

  /*
   * A cycle, broken rather than truncated.
   *
   * tasks -> issues -> tasks: an issue belongs to a task, and a task can be
   * blocked BY an issue. The descent used to stop at `depth > 4` and return
   * quietly, which did not stop the deletes - every frame above it still ran
   * its DELETE, so tasks were removed while their issues were still there and
   * the whole teardown rolled back on a foreign key. A guard that silently
   * gives up mid-graph turns a hang into a corrupt delete.
   *
   * The link that closes the cycle is optional, so it is set to NULL and the
   * descent stops there honestly. If it were ever NOT nullable the cycle would
   * be unbreakable and the teardown says so rather than half-deleting.
   */
  if (path.includes(table)) {
    if (!(await isNullable(pool, table, column))) {
      throw new Error(
        `cycle through ${path.join(" -> ")} -> ${table}.${column}, which cannot be set to NULL`,
      );
    }
    const r = await pool.query(
      `UPDATE ${table} SET ${column} = NULL WHERE ${column} = ANY($1)`, [values],
    );
    if (r.rowCount) removed[`${table}.${column}=NULL`] = (removed[`${table}.${column}=NULL`] ?? 0) + r.rowCount;
    return;
  }
  if (depth > 12) throw new Error(`teardown descended past ${depth} levels at ${table}.${column}`);

  /*
   * Asked of the catalog, not of a failed query.
   *
   * This used to `SELECT id` and swallow the error for tables that have no
   * `id`. Inside a transaction that is fatal: one failed statement aborts the
   * whole thing and every later statement returns "current transaction is
   * aborted". A tolerated failure and a real one look identical to Postgres, so
   * the tolerated one has to stop being a failure.
   */
  if (await hasIdColumn(pool, table)) {
    const mine = await pool.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${column} = ANY($1)`, [values],
    );
    const ids = mine.rows.map((r) => r.id);
    if (ids.length) {
      for (const child of await referencing(pool, table)) {
        await deleteRows(pool, child.table, child.column, ids, removed, depth + 1, [...path, table]);
      }
    }
  }

  // Not caught: a delete that fails must roll the teardown back rather than
  // leaving the project stripped of half its rows.
  const r = await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [values]);
  if (r.rowCount) removed[table] = (removed[table] ?? 0) + r.rowCount;
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

  /*
   * All of it, or none of it.
   *
   * Without a transaction a teardown that cannot delete the project still
   * deletes everything pointing AT it first - and leaves the project standing,
   * stripped. That is what happened to the seeded `alpha-web` and
   * `alpha-mobile`: an earlier version could not get past a foreign key, and
   * the projects survived with their auth_profile_allowlists rows gone. Every
   * heavy task on them then parked with "not allowlisted", which reads exactly
   * like the S12b fixture gap and is nothing of the sort.
   *
   * A half-deleted project is worse than an undeleted one, because it looks
   * fine until something tries to use it.
   */
  const client = await pool.connect();
  const tx = {
    query: (text: string, values?: unknown[]) => client.query(text, values as never),
  } as unknown as pg.Pool;
  const refs = await referencing(pool, "projects");
  try {
    await client.query("BEGIN");
    for (const ref of refs) {
      await deleteRows(tx, ref.table, ref.column, [projectId], removed);
    }
    const self = await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    if (self.rowCount) removed.projects = (removed.projects ?? 0) + self.rowCount;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`teardown rolled back for ${projectId}: ${err instanceof Error ? err.message : err}`);
    for (const k of Object.keys(removed)) delete removed[k];
  } finally {
    client.release();
  }

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
