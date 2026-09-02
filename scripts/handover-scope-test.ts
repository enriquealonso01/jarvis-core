/**
 * A call never manufactures unscoped heavy work.
 *
 * The handover filed a task with `projectId: null` whenever the phone budget
 * expired and the router had filed nothing. On a real call that turned the
 * sentence "Hello, can you finish what you were saying?" into a heavy run: the
 * router classified it `question` and filed nothing, the desk was slow, the
 * budget expired, and a pleasantry became work that landed in an empty
 * directory and tripped the isolation tripwire.
 *
 * Two rules: a call-created task always carries its project, and when there is
 * no project there is no task - the desk answers into the thread regardless.
 */
import { createPool } from "../src/db.js";
import { handoverTaskFor } from "../src/callruntime.js";

const pool = createPool();
let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function main() {
  const made: string[] = [];

  console.log("1. a conversation with no project files no task");
  const unscoped = await pool.query<{ id: string }>(
    `INSERT INTO conversations (channel) VALUES ('phone') RETURNING id`,
  );
  const id1 = await handoverTaskFor(pool, {
    conversationId: unscoped.rows[0].id,
    inboxId: null,
    heard: "Hello, can you finish what you were saying?",
  });
  id1 === null ? ok("no task") : bad(`filed task ${id1} with no project`);
  if (id1) made.push(id1);

  console.log("2. a scoped conversation still gets its task, carrying the project");
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type)
     VALUES ($1, 'Handover scope test', 'professional') RETURNING id`,
    [`handover-scope-${Date.now()}`],
  );
  const scoped = await pool.query<{ id: string }>(
    `INSERT INTO conversations (channel, project_id) VALUES ('phone', $1) RETURNING id`,
    [proj.rows[0].id],
  );
  const id2 = await handoverTaskFor(pool, {
    conversationId: scoped.rows[0].id,
    inboxId: null,
    heard: "add retries to the importer",
  });
  if (!id2) bad("a scoped handover filed nothing");
  else {
    made.push(id2);
    const t = await pool.query<{ project_id: string | null; lane: string }>(
      `SELECT project_id, lane FROM tasks WHERE id = $1`, [id2],
    );
    t.rows[0]?.project_id === proj.rows[0].id
      ? ok(`task ${id2.slice(0, 8)} carries its project`)
      : bad(`task project_id is ${t.rows[0]?.project_id}`);
    t.rows[0]?.lane === "heavy" ? ok("still the heavy lane") : bad(`lane is ${t.rows[0]?.lane}`);
  }

  console.log("3. no call-created task anywhere is unscoped");
  // The guarantee Enrique asked for, stated over the table rather than over one
  // code path: whatever route created it, a task born of a conversation has a
  // project. Scoped to this test's own rows so it cannot be tripped by history.
  const orphans = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks
      WHERE lane = 'heavy' AND project_id IS NULL AND id = ANY($1)`,
    [made],
  );
  Number(orphans.rows[0]?.n ?? 0) === 0
    ? ok("none")
    : bad(`${orphans.rows[0]?.n} unscoped task(s) created by this test`);

  for (const t of made) {
    await pool.query(`DELETE FROM task_transitions WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [t]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [t]);
  }
  await pool.query(`DELETE FROM activity_events WHERE project_id = $1`, [proj.rows[0].id]);
  await pool.query(`DELETE FROM audit_events WHERE project_id = $1`, [proj.rows[0].id]);
  await pool.query(`DELETE FROM conversations WHERE id = ANY($1)`,
    [[unscoped.rows[0].id, scoped.rows[0].id]]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [proj.rows[0].id]);
  await pool.end();

  console.log(fails === 0 ? "\nHandover scope PASS" : `\nHandover scope FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
