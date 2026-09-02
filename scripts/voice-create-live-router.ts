/**
 * Does a REAL router call these sentences `create_project`?
 *
 * Everything else about the voice-create failure has been fixed and proved with
 * the model faked, which is the right boundary for wiring: the router had no
 * category to choose, the rationale field was wired to the speaker, the
 * classifier was never given the conversation. None of those were the model's
 * fault and none of them needed a model to prove.
 *
 * This is the part that does. A category the model never picks is the same as
 * no category at all, and the only way to know is to ask a live router — which
 * needs a model route and a credential, so it runs on the box.
 *
 * It deliberately does NOT need a phone. The transcription is already known: it
 * is what Enrique actually said, word for word, disfluencies included. Putting
 * those exact strings through the live classifier tests the one remaining
 * unknown without spending his time on another call.
 *
 * Each utterance is classified in a real conversation whose history is the
 * turns before it, because that is the fix for defect 3 and turns 3 to 5 are
 * meaningless without it.
 */
import fs from "node:fs";
import { createPool } from "../src/db.js";
import { classifyInbox } from "../src/routing.js";

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
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const fixture = JSON.parse(
  fs.readFileSync(new URL("fixtures/voice-create-call.json", import.meta.url), "utf8"),
) as { turns: { n: number; heard: string }[] };

const TITLE = `live router probe ${Date.now().toString(36).slice(-6)}`;

async function clean(cid: string): Promise<void> {
  // Messages carry an inbox_event_id, so they go first.
  await pool.query("DELETE FROM messages WHERE conversation_id = $1", [cid]);
  await pool.query("DELETE FROM inbox_events WHERE conversation_id = $1", [cid]);
  await pool.query("DELETE FROM conversations WHERE id = $1", [cid]);
}

async function main(): Promise<void> {
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO conversations (title, channel) VALUES ($1, 'phone') RETURNING id`, [TITLE]);
  const cid = conv.rows[0].id;

  const verdicts: { n: number; category: string; model: string; reason: string }[] = [];

  for (const turn of fixture.turns) {
    /*
     * The message is written to `messages` before the NEXT turn is classified,
     * so each classification sees the ones before it — which is what a real
     * conversation looks like to the router now.
     */
    const ev = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events (channel, sender, raw_text, conversation_id, capture_state, processing_state)
       VALUES ('phone', 'enrique', $1, $2, 'persisted', 'pending') RETURNING id`,
      [turn.heard, cid]);

    const decision = await classifyInbox(pool, {
      inboxId: ev.rows[0].id, text: turn.heard, conversationId: cid,
    });
    verdicts.push({
      n: turn.n,
      category: String(decision.category),
      model: decision.model,
      reason: (decision.reason ?? "").slice(0, 90),
    });
    console.log(`  ${turn.n}. ${decision.category.padEnd(15)} ${turn.heard.slice(0, 62)}`);
    if (decision.reason) console.log(`     reason: ${decision.reason.slice(0, 96)}`);

    await pool.query(
      `INSERT INTO messages (conversation_id, inbox_event_id, role, body) VALUES ($1, $2, 'user', $3)`,
      [cid, ev.rows[0].id, turn.heard]);
  }

  console.log("\n########## what a real router made of it ##########\n");
  {
    const answered = verdicts.filter((v) => v.model !== "none");
    truthy("a real router answered at all", answered.length === verdicts.length);
    if (answered.length !== verdicts.length) {
      console.log(`        ${verdicts.length - answered.length} turns got no model route`);
    }

    /*
     * Turn 1 is the whole question. "I want to create a project called Test
     * Project" was classified CAPTURE in production and answered "remembered:".
     * If a live router still does not call this create_project, the category
     * exists and is never chosen, and the fix is not a fix.
     */
    const first = verdicts.find((v) => v.n === 1);
    truthy(`turn 1 is create_project (was capture in production) — got ${first?.category}`,
      first?.category === "create_project");

    /*
     * Turns 3, 4 and 5 are the context test. Each is a fragment: "just select
     * the defaults", "test project one", "because I'm asking you to create it".
     * On their own they mean nothing, and the production router said so in the
     * third person. With the conversation in front of it, they should stay on
     * the same subject.
     */
    const fragments = verdicts.filter((v) => [3, 4, 5].includes(v.n));
    const onSubject = fragments.filter((v) => v.category === "create_project");
    truthy(
      `the fragments stay on the subject: ${onSubject.length}/3 `
      + `(${fragments.map((f) => `${f.n}:${f.category}`).join(" ")})`,
      onSubject.length >= 2,
    );

    /*
     * And the one that is genuinely not about creating anything. "Thank you.
     * You can exit now." must NOT become a project — a category that swallows
     * everything is as broken as one that is never chosen.
     */
    const last = verdicts.find((v) => v.n === 6);
    truthy(`the goodbye is not a project request — got ${last?.category}`,
      last?.category !== "create_project");
  }

  await clean(cid);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.stack : err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
