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
/*
 * `passes` exists for the sweep, not for the reader.
 *
 * scripts/sweep.sh decides whether a suite ran by grepping for one exact line:
 * `==== N passed, M failed ====`. These suites printed their own summary instead,
 * so the sweep reported all seven as "NO SUMMARY - the suite did not finish"
 * while each of them passed perfectly well on its own. Adding a suite to the net
 * is not the same as the net being able to see it.
 */
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function main() {
  const made: string[] = [];

  console.log("1. routing decided it was not work, so nothing is filed");
  // "Hello, can you finish what you were saying?" - the router classified this
  // `question` and filed nothing. The handover turning it into a heavy run is
  // how a pleasantry became a task that landed in an empty directory.
  const unscoped = await pool.query<{ id: string }>(
    `INSERT INTO conversations (channel) VALUES ('phone') RETURNING id`,
  );
  const id1 = await handoverTaskFor(pool, {
    conversationId: unscoped.rows[0].id,
    inboxId: null,
    heard: "Hello, can you finish what you were saying?",
    routerHandled: true,
  });
  id1 === null ? ok("no task") : bad(`filed task ${id1} for a pleasantry`);
  if (id1) made.push(id1);

  console.log("2. routing never answered, so the request is NOT dropped");
  /*
   * The case the first fix broke. Keying on the project meant an unscoped call
   * whose desk was slow filed nothing at all, so a real request vanished - and
   * S21 requires the handover to carry the FULL request to a task.
   */
  const id2 = await handoverTaskFor(pool, {
    conversationId: unscoped.rows[0].id,
    inboxId: null,
    heard: "check the alpha migration",
    routerHandled: false,
  });
  if (!id2) bad("a real request was dropped when routing timed out");
  else {
    made.push(id2);
    const t = await pool.query<{ objective: string; lane: string }>(
      `SELECT objective, lane FROM tasks WHERE id = $1`, [id2]);
    ok(`filed task ${id2.slice(0, 8)}`);
    t.rows[0]?.objective === "check the alpha migration"
      ? ok("carrying the full request, not a summary")
      : bad(`objective is ${t.rows[0]?.objective}`);
  }

  console.log("3. a scoped conversation files against its project");
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type)
     VALUES ($1, 'Handover scope test', 'professional') RETURNING id`,
    [`handover-scope-${Date.now()}`],
  );
  const scoped = await pool.query<{ id: string }>(
    `INSERT INTO conversations (channel, project_id) VALUES ('phone', $1) RETURNING id`,
    [proj.rows[0].id],
  );
  const id3 = await handoverTaskFor(pool, {
    conversationId: scoped.rows[0].id,
    inboxId: null,
    heard: "add retries to the importer",
    routerHandled: false,
  });
  if (!id3) bad("a scoped handover filed nothing");
  else {
    made.push(id3);
    const t = await pool.query<{ project_id: string | null }>(
      `SELECT project_id FROM tasks WHERE id = $1`, [id3]);
    t.rows[0]?.project_id === proj.rows[0].id
      ? ok("the task carries its project")
      : bad(`task project_id is ${t.rows[0]?.project_id}`);
  }

  console.log("4. and unscoped work still cannot RUN");
  /*
   * The harm this all started from is prevented in the runner, not by refusing
   * to write the words down: a heavy task with no project parks instead of
   * starting a harness in an empty directory (scripts/unscoped-heavy-test.sh).
   */
  const guard = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks WHERE id = $1 AND project_id IS NULL`, [id2 ?? null],
  );
  Number(guard.rows[0]?.n ?? 0) === 1
    ? ok("the unscoped one exists, and the runner is what refuses it")
    : bad("expected the unscoped task to exist and be left to the runner");

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

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  console.log(fails === 0 ? "Handover scope PASS" : `Handover scope FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
