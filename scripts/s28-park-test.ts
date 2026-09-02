/**
 * S28 — "Point a task at a runtime that is not installed → a clean
 * `provider.cred_expired`-class park with a useful message, not a crash."
 *
 * A separate suite from the normalisation one because this needs the database
 * and the real runner. It drives `runHeavyTask` rather than the queue: the queue
 * has its own tests, and what is under examination here is what the runner does
 * the moment it discovers it cannot start the engine it was told to use.
 *
 * The assertions are about the SHAPE of the failure, not merely that it failed.
 * A crash also fails; so does a silent fallback to whichever engine happens to
 * be installed, which would be worse than either — S28 exists so that "which
 * engine produced this?" has an answer, and an engine substituted quietly makes
 * that answer a lie.
 */
import { createPool } from "../src/db.js";
import { runHeavyTask } from "../src/runner.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const STAMP = Date.now().toString(36).slice(-6);

async function clean(): Promise<void> {
  for (const sql of [
    `DELETE FROM issues WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM task_transitions WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM task_context WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM audit_events WHERE target IN (SELECT id::text FROM tasks WHERE title LIKE $1)`,
    `DELETE FROM tasks WHERE title LIKE $1`,
  ]) await pool.query(sql, [`%${STAMP}%`]);
}

async function makeTask(runtime: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tasks (title, objective, lane, state, priority, runtime)
     VALUES ($1, 'do a thing', 'heavy', 'running', 'normal', $2) RETURNING id`,
    [`s28 park ${runtime} ${STAMP}`, runtime],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  await clean();

  console.log("########## a runtime that is not installed ##########\n");
  {
    /*
     * `cursor` is a real entry nobody has installed here... except it might be.
     * So the id is one that cannot possibly exist, which keeps the test honest
     * on any host: what is being tested is the refusal path, not this box.
     */
    const id = await makeTask("codex-that-is-not-here");
    await runHeavyTask(pool, id);

    const t = await pool.query<{ state: string; waiting_reason: string; ran_on_runtime: string | null }>(
      `SELECT state, waiting_reason, ran_on_runtime FROM tasks WHERE id = $1`, [id]);
    check("the task parks rather than failing", "waiting_for_user", t.rows[0]?.state);
    truthy("with a reason naming the runtime",
      (t.rows[0]?.waiting_reason ?? "").includes("codex-that-is-not-here"));
    /*
     * Nothing ran, so nothing may claim to have run. This is the assertion that
     * catches a silent fallback: if the runner had quietly used claude, this
     * column would say claude and the park would not have happened.
     */
    check("and nothing is recorded as having run it", null, t.rows[0]?.ran_on_runtime);

    const issue = await pool.query<{ category: string; required_action: string; status: string }>(
      `SELECT category, required_action, status FROM issues WHERE task_id = $1`, [id]);
    check("an issue is raised", 1, issue.rowCount);
    check("in the config.invalid class", "config.invalid", issue.rows[0]?.category);
    truthy("telling him what the known runtimes are",
      (issue.rows[0]?.required_action ?? "").includes("claude"));
    check("and waiting on him", "waiting_for_user", issue.rows[0]?.status);
  }

  console.log("\n########## a real runtime whose binary is absent ##########\n");
  {
    /*
     * The other half: the id IS known, the binary is not there. This is the
     * `provider.cred_expired`-class park the plan names, and it is a different
     * failure from an unknown id — one is a typo, the other is a host that has
     * not been set up, and telling him the wrong one wastes his time.
     */
    const id = await makeTask("codex");
    await runHeavyTask(pool, id);

    const t = await pool.query<{ state: string; waiting_reason: string }>(
      `SELECT state, waiting_reason FROM tasks WHERE id = $1`, [id]);
    const issue = await pool.query<{ category: string; required_action: string }>(
      `SELECT category, required_action FROM issues WHERE task_id = $1`, [id]);

    if (issue.rows[0]?.category === "provider.cred_expired") {
      ok("codex is absent here, and the park says so");
      check("parked, not failed", "waiting_for_user", t.rows[0]?.state);
      truthy("and says it can be requeued once it exists",
        (issue.rows[0]?.required_action ?? "").includes("requeued"));
    } else {
      /*
       * Codex IS installed on this host (it is on the box). Then this task got
       * past the availability check, which is itself the correct behaviour — so
       * assert that instead of pretending the branch was exercised.
       */
      ok("codex is installed here, so the availability check let it through");
      const ran = await pool.query<{ ran_on_runtime: string | null }>(
        `SELECT ran_on_runtime FROM tasks WHERE id = $1`, [id]);
      check("and the run is recorded against codex", "codex", ran.rows[0]?.ran_on_runtime);
    }
  }

  await clean();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
