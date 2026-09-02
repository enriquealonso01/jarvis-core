/**
 * A phone call must not create work with nowhere to do it.
 *
 * From the 19:44 call. Turn 7 was "Hello, can you finish what you were saying?"
 * — conversational filler, nothing to do. The desk was slow, the phone-side
 * budget expired, and the handover turned that sentence into heavy task
 * 4e768fe6 with `projectId: null`. The runner then had no repository, so it
 * worked in `worktrees/unscoped/`, so the isolation tripwire raised a CRITICAL,
 * so a security event rang Enrique's phone INSIDE quiet hours.
 *
 * Five behaviours, each correct on its own, chained from one missing fact.
 *
 * The same defect was reported at 13:09 and marked resolved. What was fixed
 * then was the DUPLICATE task — the handover no longer files when the router
 * already has. The project-less case was left, and the comment above the code
 * described exactly this chain while the line below it still passed
 * `projectId: null`. So this asserts the invariant rather than the fix:
 *
 *   a task created from a call always has a project.
 */
import { createPool } from "../src/db.js";
import { spokenSummary } from "../src/routing.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 200)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

/** The internal labels that were read aloud, and the shape of them. */
const INTERNAL = [
  /^config task:/i, /^remembered:/i, /^task in [a-z0-9-]+:/i, /^asked about:/i,
  /^could not place/i,
];
const leaks = (t: string) => INTERNAL.find((re) => re.test(t.trim()))?.source ?? null;

/**
 * Leftovers from a previous run, removed before this one starts.
 *
 * A suite that only cleans up AFTERWARDS cannot recover from its own crash: the
 * first failure here left the fixture project behind, and every later run then
 * died on a duplicate slug — a failure that looks like a new bug and is the old
 * one's litter.
 *
 * The tables are asked for, not listed. A hand-written list had four; there are
 * twenty tables with a foreign key to `projects`, and each missing one is a
 * teardown error that leaves the fixture behind again.
 */
async function cleanFixtures(): Promise<void> {
  const convs = await pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE title IN ('unscoped call probe', 'scoped call probe')");
  const ids = convs.rows.map((r) => r.id);
  if (ids.length) {
    for (const t of ["task_transitions", "task_events", "task_attempts", "task_context"]) {
      await pool.query(
        `DELETE FROM ${t} WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id = ANY($1::uuid[]))`,
        [ids]).catch(() => undefined);
    }
    await pool.query("DELETE FROM tasks WHERE conversation_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM conversations WHERE id = ANY($1::uuid[])", [ids]);
  }

  const p = await pool.query<{ id: string }>("SELECT id FROM projects WHERE slug = 'unscoped-probe'");
  if (!p.rows[0]) return;
  const pid = p.rows[0].id;

  // Tasks first: other tables hang off them and would block the delete.
  for (const t of ["task_transitions", "task_events", "task_attempts", "task_context"]) {
    await pool.query(
      `DELETE FROM ${t} WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`, [pid],
    ).catch(() => undefined);
  }
  const refs = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT DISTINCT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'projects'`,
  );
  for (const r of refs.rows) {
    await pool.query(`DELETE FROM ${r.table_name} WHERE ${r.column_name} = $1`, [pid])
      .catch(() => undefined);
  }
  await pool.query("DELETE FROM projects WHERE id = $1", [pid]);
}

async function main(): Promise<void> {
  await cleanFixtures();
  console.log("########## nothing spoken is an internal label ##########\n");
  {
    /*
     * `summariseRoute` renders `summary` straight to the caller, and on the
     * phone that is read aloud. Every one of these used to be a label with his
     * own sentence stapled on and cut at sixty characters.
     */
    const said = [
      spokenSummary("remembered", "Yeah, if I don't mention anything, you should always go for the defaults"),
      spokenSummary("instruction", "Yeah, if I don't mention anything, you should always go for the defaults"),
      spokenSummary("work", "Fix the trailing dash", "slugkit"),
    ];
    for (const s of said) {
      check(`"${s.slice(0, 46)}" is not a label`, null, leaks(s));
      truthy("...and is a sentence, not a fragment", /[.:…]$|[a-z]$/i.test(s.trim()));
    }
    truthy("a capture says what became of it, without reciting him",
      !said[0].includes("I don't mention anything"));
    truthy("an instruction says what became of it too",
      !said[1].includes("I don't mention anything"));
    /*
     * Work is the exception: the TITLE is Jarvis's own words, written for the
     * queue, so saying it back is informative rather than a recital.
     */
    truthy("work names where it was queued", said[2].includes("slugkit"));
  }

  console.log("\n########## a call never creates work it cannot do ##########\n");
  {
    const { handoverTaskFor } = await import("../src/callruntime.js");

    // A conversation with no project — the 19:44 case.
    const loose = await pool.query<{ id: string }>(
      `INSERT INTO conversations (title, channel) VALUES ('unscoped call probe', 'phone') RETURNING id`);
    const noProject = await handoverTaskFor(pool, {
      conversationId: loose.rows[0].id, inboxId: null,
      heard: "Hello, can you finish what you were saying?",
    });
    check("filler on an unscoped call creates no task", null, noProject);

    const stray = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tasks
       WHERE conversation_id = $1 AND project_id IS NULL AND lane = 'heavy'`,
      [loose.rows[0].id]);
    check("and nothing project-less was left behind", "0", stray.rows[0].n);

    // The same sentence on a call that IS scoped to a project.
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (slug, name, is_system, project_type, confidentiality)
       VALUES ('unscoped-probe', 'Unscoped probe', false, 'personal', 'normal') RETURNING id`);
    const scoped = await pool.query<{ id: string }>(
      `INSERT INTO conversations (title, channel, project_id) VALUES ('scoped call probe', 'phone', $1) RETURNING id`,
      [proj.rows[0].id]);
    const made = await handoverTaskFor(pool, {
      conversationId: scoped.rows[0].id, inboxId: null,
      heard: "Please fix the trailing dash in slugify.",
    });
    truthy("a scoped call can still hand work over", made);
    if (made) {
      const row = await pool.query<{ project_id: string | null }>(
        "SELECT project_id FROM tasks WHERE id = $1", [made]);
      check("and it carries the project", proj.rows[0].id, row.rows[0]?.project_id);
    }

    /*
     * Teardown by asking the schema what points at these rows, not by listing
     * it. The hand-written list broke three times in one session, each time
     * because the code under test got FURTHER than before and wrote a table the
     * list had never needed.
     */
    const ids = [loose.rows[0].id, scoped.rows[0].id];
    for (const t of ["task_transitions", "task_events", "task_attempts", "task_context"]) {
      await pool.query(
        `DELETE FROM ${t} WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id = ANY($1::uuid[]))`,
        [ids]).catch(() => undefined);
    }
    await pool.query("DELETE FROM tasks WHERE conversation_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM conversations WHERE id = ANY($1::uuid[])", [ids]);
    for (const t of ["activity_events", "audit_events"]) {
      await pool.query(
        `DELETE FROM ${t} WHERE project_id = (SELECT id FROM projects WHERE slug = 'unscoped-probe')`,
      ).catch(() => undefined);
    }
    await pool.query("DELETE FROM projects WHERE slug = 'unscoped-probe'");
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.stack : err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
