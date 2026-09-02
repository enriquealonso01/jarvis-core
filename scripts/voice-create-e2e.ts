/**
 * A project created by talking, through the real dispatcher.
 *
 * This is the test that did not exist when Enrique picked up the phone, and its
 * absence is why five defects reached him at once. S26's suites drive `runTool`
 * directly — they prove the onboarding tools work, and they cannot see whether
 * anything ever calls them. This drives `ingestUserMessage`, which is what a
 * spoken turn actually reaches:
 *
 *   utterance -> classifyInbox -> applyRoute -> passthrough -> runSupervisorTurn
 *             -> runTool -> onboarding -> a project row
 *
 * Only the MODEL is faked, and that is the honest boundary. A real model cannot
 * be made deterministic, and the five defects were not model failures: the
 * router had no category to choose, the rationale field was wired to the
 * speaker, the classifier was never given the conversation, and the prompt
 * described only professional projects. Every one of those is wiring, and
 * wiring is what this asserts.
 *
 * What it therefore does NOT prove: that a real classifier chooses
 * `create_project` for "I want to create a project called Test Project". That
 * needs a live call, and it is the one thing left before asking him to make one.
 */
import { createPool } from "../src/db.js";
import { ingestUserMessage } from "../src/inbox.js";

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

const SLUG = "test-project-voice";

/** The same detector the router suite uses, on everything said back. */
const THIRD_PERSON = [
  /\bHe (wants|asks|said|is asking)\b/i, /\bThe user\b/i, /\bThe message is\b/i,
  /\bcannot determine what is being asked\b/i, /\bthe caller\b/i,
];
const rationale = (t: string) => THIRD_PERSON.find((re) => re.test(t))?.source ?? null;

async function clean(): Promise<void> {
  for (const sql of [
    `DELETE FROM project_instructions_versions WHERE project_id IN (SELECT id FROM projects WHERE slug = $1)`,
    `DELETE FROM audit_events WHERE project_id IN (SELECT id FROM projects WHERE slug = $1)`,
    `DELETE FROM onboarding_sessions WHERE project_id IN (SELECT id FROM projects WHERE slug = $1)`,
    `DELETE FROM projects WHERE slug = $1`,
  ]) await pool.query(sql, [SLUG]);
  await pool.query(
    `DELETE FROM onboarding_sessions WHERE conversation_id IN
       (SELECT id FROM conversations WHERE title = 'voice create e2e')`);
  await pool.query(
    `DELETE FROM memory_items WHERE body LIKE '%create a project called Test Project%'`);
  await pool.query(
    `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE title = 'voice create e2e')`);
  await pool.query(
    `DELETE FROM inbox_events WHERE conversation_id IN
       (SELECT id FROM conversations WHERE title = 'voice create e2e')`);
  await pool.query(`DELETE FROM conversations WHERE title = 'voice create e2e'`);
}

async function main(): Promise<void> {
  await clean();

  const conv = await pool.query<{ id: string }>(
    `INSERT INTO conversations (title, channel) VALUES ('voice create e2e', 'phone') RETURNING id`);
  const cid = conv.rows[0].id;

  /*
   * Three turns, in the shape the real call took: the request, the answer to
   * "personal or professional", and the answers to what is left. The second
   * turn says "just use the defaults" because that is what he actually said,
   * and there was no way to accept it.
   */
  const said = [
    "I want to create a project called Test Project.",
    "It is personal, and just use the defaults.",
    "There is no repository, no auth profiles, and nobody deploys it.",
  ];

  const replies: string[] = [];
  for (const text of said) {
    const r = await ingestUserMessage(pool, { conversationId: cid, body: text, channel: "phone" });
    replies.push(r.assistant ?? "");
    console.log(`  > ${text}`);
    console.log(`  < ${(r.assistant ?? "(nothing)").slice(0, 140)}`);
  }

  console.log("\n########## the verdict was written down ##########\n");
  {
    /*
     * routing.ts opens by saying "Wrong routing is invisible otherwise, and the
     * documented way to find the bug is to read a day of verdicts". That only
     * holds if the verdict can be written.
     *
     * It could not. `create_project` was added to CATEGORIES and the CHECK
     * constraint on `inbox_events.route_category` still listed the original
     * five, so every one of these verdicts was rejected — and the write is
     * deliberately wrapped in a catch, because a routing record must never take
     * a message down. The result was perfect behaviour and no record of it:
     * project created, reply correct, route_category null.
     *
     * Asserted here rather than trusted, because the whole failure mode is that
     * nothing complains.
     */
    const ev = await pool.query<{ route_category: string | null; route_model: string | null }>(
      `SELECT route_category, route_model FROM inbox_events
       WHERE conversation_id = $1 ORDER BY received_at LIMIT 1`, [cid]);
    check("the first turn's verdict persisted", "create_project", ev.rows[0]?.route_category);
    check("naming the router as what decided it", "router", ev.rows[0]?.route_model);
  }

  console.log("\n########## he was never described in the third person ##########\n");
  for (const [i, r] of replies.entries()) {
    check(`turn ${i + 1} said nothing about him`, null, rationale(r));
  }

  console.log("\n########## and nothing was merely remembered ##########\n");
  {
    /*
     * The original failure in one assertion. "I want to create a project called
     * Test Project" was filed as something to REMEMBER and answered
     * "remembered: <his words>" — the request was recorded and never acted on.
     */
    truthy("no reply claimed to have remembered it",
      !replies.some((r) => /^remembered:/im.test(r)));
    const mem = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_items WHERE body LIKE '%create a project called Test Project%'`);
    check("and nothing was written to memory instead of acted on", "0", mem.rows[0].n);
  }

  console.log("\n########## the project exists ##########\n");
  {
    const p = await pool.query<{ id: string; name: string; project_type: string; confidentiality: string }>(
      `SELECT id, name, project_type, confidentiality FROM projects WHERE slug = $1`, [SLUG]);
    check("a project was created", 1, p.rowCount);
    if (p.rows[0]) {
      check("with the name he gave", "Test Project", p.rows[0].name);
      // Defect 4: it asked him for the professional four on a project he called
      // personal, because the prompt described only the professional case.
      check("as PERSONAL, which is what he said", "personal", p.rows[0].project_type);
      check("and not quietly made confidential", "normal", p.rows[0].confidentiality);

      const v = await pool.query<{ version: number; body: string }>(
        `SELECT version, body FROM project_instructions_versions WHERE project_id = $1`, [p.rows[0].id]);
      check("its AGENTS.md was written", 1, v.rowCount);
      truthy("with no placeholder left in it", !/\{\{[a-z_]+\}\}/.test(v.rows[0]?.body ?? "x{{y}}"));
      truthy("naming the project he asked for", (v.rows[0]?.body ?? "").includes("Test Project"));
    }
  }

  console.log("\n########## 'use the defaults' answered the build questions, not the others ##########\n");
  {
    const sess = await pool.query<{ answers: Record<string, string> }>(
      `SELECT answers FROM onboarding_sessions WHERE conversation_id = $1
       ORDER BY created_at DESC LIMIT 1`, [cid]);
    const a = sess.rows[0]?.answers ?? {};
    check("the build questions were defaulted", "none", a.test_command);
    check("the branch got a real default", "main", a.default_branch);
    /*
     * And the ones that are his stayed his: he answered these out loud on turn
     * 3, so they must carry HIS words rather than a default that ran first.
     */
    check("the repository was his answer", "none", a.github_owner);
    check("so was the deploy policy", "none", a.deploy_policy);
    check("and the type he chose", "personal", a.project_type);
  }

  await clean();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err));
    fail += 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
