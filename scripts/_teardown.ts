/**
 * Deleting a fixture row and everything that points at it.
 *
 * WHY THIS IS NOT A LIST OF TABLES. `s12-isolation-test` created two projects
 * per run and never removed them; 20 accumulated in one hour of sweeps, and
 * `no-test-litter-test` - which runs last in sweep.sh - failed on them, so a
 * fully green sweep was unreachable. The obvious fix, copying
 * `confidential-eligibility-test`'s `DELETE FROM projects WHERE id = ANY($1)`,
 * fails immediately on a foreign key from `issues`.
 *
 * The next obvious fix is to delete from the child tables first, and there are
 * TWENTY-NINE of them referencing `projects` today. Writing that list down is
 * the exact pattern this repo keeps getting caught by: it would be right about
 * the tables somebody remembered and silently wrong about the thirtieth, and
 * the failure would look like a flaky teardown rather than a missing entry.
 *
 * So the graph is DISCOVERED from `pg_constraint` at run time. A table added
 * next month is handled because nothing here knows the current list, which is
 * the same argument `constructEnvironment` makes for building an environment
 * rather than subtracting from one.
 *
 * The recursion matters as much as the discovery: deleting `conversations`
 * because it points at `projects` can itself violate a constraint from
 * something pointing at `conversations`. So children are resolved depth-first,
 * with a visited set, because the schema contains at least one self-reference
 * (`routing_overrides` appears twice in the constraint list) and a cycle here
 * would be an infinite loop against the database.
 */
import type pg from "pg";

type Ref = { childTable: string; childColumn: string; parentColumn: string };

/** Who points at this table, and through which column. */
async function referencesTo(pool: pg.Pool, table: string): Promise<Ref[]> {
  const r = await pool.query<Ref>(
    `SELECT c.conrelid::regclass::text AS "childTable",
            a.attname                 AS "childColumn",
            af.attname                AS "parentColumn"
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey)  WITH ORDINALITY AS k(attnum, ord)  ON true
       JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum = k.attnum
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = fk.attnum
      WHERE c.confrelid = $1::regclass AND c.contype = 'f'`,
    [table],
  );
  return r.rows;
}

/**
 * Delete these rows, and everything that would block it.
 *
 * Returns what it removed, per table, so a teardown can be asserted on rather
 * than hoped about — a silent no-op is how a teardown stops working without
 * anybody noticing.
 */
/**
 * Clear one nullable pointer that a delete tripped over.
 *
 * Takes the constraint name from the error rather than a guess about which
 * columns are pointers, and refuses to touch a NOT NULL column — there the
 * reference is structural and nulling it would be a different kind of damage.
 */
async function clearPointer(
  pool: pg.Pool, constraint: string, parentTable: string, parentFilterColumn: string,
  values: unknown[],
): Promise<number> {
  const r = await pool.query<{ childTable: string; childColumn: string; parentColumn: string;
    nullable: string }>(
    `SELECT c.conrelid::regclass::text AS "childTable",
            a.attname AS "childColumn", af.attname AS "parentColumn", col.is_nullable AS nullable
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey)  WITH ORDINALITY AS k(attnum, ord)  ON true
       JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
       JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum = k.attnum
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = fk.attnum
       JOIN information_schema.columns col
         ON col.table_name = c.conrelid::regclass::text AND col.column_name = a.attname
      WHERE c.conname = $1`,
    [constraint],
  );
  const ref = r.rows[0];
  if (!ref || ref.nullable !== "YES") return 0;
  const matchOn = await pool.query(
    `SELECT DISTINCT ${quote(ref.parentColumn)} AS v FROM ${quote(parentTable)}
      WHERE ${quote(parentFilterColumn)} = ANY($1)`,
    [values],
  );
  const ids = matchOn.rows.map((x) => x.v).filter((v) => v !== null);
  if (!ids.length) return 0;
  const upd = await pool.query(
    `UPDATE ${quote(ref.childTable)} SET ${quote(ref.childColumn)} = NULL
      WHERE ${quote(ref.childColumn)} = ANY($1)`,
    [ids],
  );
  return upd.rowCount ?? 0;
}

export async function deleteCascade(
  pool: pg.Pool,
  table: string,
  column: string,
  values: unknown[],
  seen = new Set<string>(),
  depth = 0,
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  if (!values.length || depth > 12) return removed;

  /*
   * The guard is on table AND column rather than table alone: a table can point
   * at the same parent through two different columns, and collapsing those
   * would skip one of them.
   */
  const key = `${table}.${column}@${depth}`;
  if (seen.has(key)) return removed;
  seen.add(key);

  for (const ref of await referencesTo(pool, table)) {
    /*
     * The values the CHILD is matched on are the parent's `parentColumn`, read
     * off the constraint and selected from the PARENT table.
     *
     * The first version selected `childColumn` from the child table using the
     * values being deleted, which is only correct one level down. Two levels
     * down it asked `call_turns` for a `task_id` equal to a project id, and
     * Postgres said the column does not exist - which is the good outcome; the
     * bad one is a column name that happens to exist on both tables and a
     * teardown that silently deletes the wrong rows.
     *
     * `parentColumn` is usually `id` but is not assumed: a foreign key to a
     * natural key such as `slug` is legal.
     */
    const parentValues = await pool.query(
      `SELECT DISTINCT ${quote(ref.parentColumn)} AS v FROM ${quote(table)}
        WHERE ${quote(column)} = ANY($1)`,
      [values],
    );
    const matchOn = parentValues.rows.map((x) => x.v).filter((v) => v !== null);
    if (!matchOn.length) continue;

    const nested = await deleteCascade(
      pool, ref.childTable, ref.childColumn, matchOn, seen, depth + 1);
    for (const [t, n] of Object.entries(nested)) removed[t] = (removed[t] ?? 0) + n;
  }

  /*
   * Some references are pointers, not components, and Postgres is the one that
   * knows which.
   *
   * `tasks.blocked_by_issue_id` points at an issue belonging to the project
   * being removed, from a task belonging to a DIFFERENT project. Cascading into
   * it would delete somebody else's task; refusing to handle it aborts the whole
   * reap and leaves the fixture standing, which is what happened.
   *
   * Nulling every nullable foreign key would be the obvious general rule and is
   * wrong: `conversations.project_id` is nullable too, and nulling it leaves the
   * conversation behind — which is exactly the leftover thread that started this
   * investigation. So the rule is not applied by guessing which columns are
   * pointers. The delete is attempted, and only the column Postgres NAMES in the
   * violation is cleared, and only if it is nullable. The database decides,
   * once, about the one reference that actually blocked.
   */
  const removeRows = async (): Promise<number> => {
    const del = await pool.query(
      `DELETE FROM ${quote(table)} WHERE ${quote(column)} = ANY($1)`, [values]);
    return del.rowCount ?? 0;
  };
  try {
    removed[table] = (removed[table] ?? 0) + await removeRows();
  } catch (err) {
    const constraint = (err as { constraint?: string }).constraint;
    const cleared = constraint ? await clearPointer(pool, constraint, table, column, values) : 0;
    if (!cleared) throw err;
    removed[`${constraint} (nulled)`] = cleared;
    removed[table] = (removed[table] ?? 0) + await removeRows();
  }
  return removed;
}

/**
 * Identifiers come from `pg_constraint`, not from a caller, so they are already
 * trustworthy - but they are quoted anyway. An identifier interpolated into SQL
 * because "it came from the catalogue" is a habit that survives the move to a
 * place where it did not.
 */
function quote(ident: string): string {
  if (!/^[a-z_][a-z0-9_$]*$/i.test(ident)) {
    throw new Error(`refusing to interpolate an unexpected identifier: ${ident}`);
  }
  return `"${ident}"`;
}

/** The common case: take these projects and everything hanging off them. */
export async function deleteProjects(
  pool: pg.Pool,
  ids: string[],
): Promise<Record<string, number>> {
  return deleteCascade(pool, "projects", "id", ids);
}
