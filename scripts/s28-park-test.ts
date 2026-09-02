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

/**
 * Tear down by asking the schema what points at `tasks`, rather than by keeping
 * a hand-written list.
 *
 * The list approach failed three times in a row here — `task_transitions`, then
 * `task_attempts`, then `task_checkpoints` — each time because the run got
 * FURTHER than the previous one and wrote a table the teardown had never had to
 * know about. That is a test whose cleanup encodes an assumption about how far
 * the code gets, which is precisely the thing under change.
 */
async function clean(): Promise<void> {
  const like = `%${STAMP}%`;
  const refs = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT DISTINCT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'tasks'`,
  );
  for (const r of refs.rows) {
    await pool.query(
      `DELETE FROM ${r.table_name} WHERE ${r.column_name} IN (SELECT id FROM tasks WHERE title LIKE $1)`,
      [like],
    ).catch(() => undefined);
  }
  await pool.query(
    `DELETE FROM audit_events WHERE target IN (SELECT id::text FROM tasks WHERE title LIKE $1)`, [like]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [like]);
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

  console.log("\n########## asking for an engine the credential cannot drive ##########\n");
  {
    /*
     * The failure this exists to prevent, and the reason the runtime is taken
     * from the chosen credential rather than from a field of its own: a task
     * pinned to codex, while the only usable engineering credential is the
     * Anthropic subscription. Running `codex` against Anthropic's login does not
     * fail loudly — codex finds no session and reports 401, which reads exactly
     * like an expired subscription and sends you looking in the wrong place.
     *
     * An auth directory and a CLI are a matched pair, so this parks.
     */
    const id = await makeTask("codex");
    await runHeavyTask(pool, id);

    const t = await pool.query<{ state: string; waiting_reason: string; ran_on_runtime: string | null }>(
      `SELECT state, waiting_reason, ran_on_runtime FROM tasks WHERE id = $1`, [id]);

    /*
     * The shape of this changed while it was being written, and for the better.
     *
     * It first asserted a MISMATCH park: the ladder handed back Anthropic, the
     * runner noticed the task wanted codex, and refused. That refusal is now
     * unreachable, because `task.runtime` FILTERS the ladder instead of being
     * checked after it — a codex task is only ever offered codex routes. The
     * wrong credential can no longer be selected, so there is nothing left to
     * catch late.
     *
     * What is asserted is therefore the outcome, not the mechanism: it parks
     * without running, and the reason names the engine that was asked for.
     * Asserting the old mechanism would be asserting that the weaker design is
     * still in place.
     */
    check("it parks rather than running on the wrong credential", "waiting_for_provider", t.rows[0]?.state);
    check("nothing is recorded as having run it", null, t.rows[0]?.ran_on_runtime);
    truthy("the reason names the engine it was pinned to",
      (t.rows[0]?.waiting_reason ?? "").includes("codex"));
    truthy("and says why each other route was not it",
      /not the codex this task asked for|no engineering route is registered/i
        .test(t.rows[0]?.waiting_reason ?? ""));
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
