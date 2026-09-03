/**
 * S39 — start by voice, add by WhatsApp, finish in the console.
 *
 *   "Start a request by voice, add to it by WhatsApp, finish it in the console.
 *    **One task, one conversation, nothing restated.**"
 *
 *   Debug: "If context is lost across channels, look for a **per-channel
 *    conversation being created rather than the existing one being joined**."
 *
 * So the central assertion is a COUNT: after three messages on three surfaces,
 * exactly one conversation exists. Asserting that the third message "found a
 * conversation" would pass on a system that made three, because each one would
 * find its own.
 */
import { createPool } from "../src/db.js";
import {
  channelsOf, CONTINUITY_WINDOW_MINUTES, resolveConversation,
} from "../src/continuity.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s39c-${Math.random().toString(36).slice(2, 7)}`;
const T0 = new Date("2026-09-04T14:00:00Z");
const mins = (n: number) => new Date(T0.getTime() + n * 60_000);

async function main(): Promise<void> {
  const mk = async (s: string) => (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [s])).rows[0].id;
  const alpha = await mk(SLUG);
  const beta = await mk(`${SLUG}-other`);

  const countFor = async (pid: string) => Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM conversations WHERE project_id = $1`, [pid])).rows[0].n);

  try {
    console.log("1. the same request across three surfaces");
    const voice = await resolveConversation(pool, {
      channel: "phone", projectId: alpha, title: `${SLUG} thread`, now: T0,
    });
    voice.outcome === "created" ? ok("voice starts a thread") : bad("voice joined something unexpected");

    const whatsapp = await resolveConversation(pool, {
      channel: "whatsapp", projectId: alpha, now: mins(20),
    });
    whatsapp.conversationId === voice.conversationId
      ? ok(`WhatsApp joins it twenty minutes later: ${whatsapp.why}`)
      : bad("WhatsApp started a second conversation");

    const console_ = await resolveConversation(pool, {
      channel: "web", projectId: alpha, now: mins(45),
    });
    console_.conversationId === voice.conversationId
      ? ok("and the console finishes in the same one")
      : bad("the console started a third conversation");

    /*
     * The assertion that actually catches the bug. "The third message found a
     * conversation" is true on a system that made three - each one finds its
     * own.
     */
    (await countFor(alpha)) === 1
      ? ok("ONE conversation exists after three surfaces, not three")
      : bad(`${await countFor(alpha)} conversations were created for one request`);

    const touched = await channelsOf(pool, voice.conversationId);
    ["phone", "whatsapp", "web"].every((c) => touched.includes(c))
      ? ok(`and it records every surface that touched it: ${touched.join(", ")}`)
      : bad(`channels recorded: ${touched.join(", ")}`);
    touched.length === 3
      ? ok("each one once, so a repeated surface does not accumulate")
      : bad(`${touched.length} entries for three surfaces`);

    console.log("");
    console.log("2. continuity never reaches across a project");
    const other = await resolveConversation(pool, {
      channel: "whatsapp", projectId: beta, now: mins(46),
    });
    other.conversationId !== voice.conversationId
      ? ok("a different project gets its own thread, even seconds later")
      : bad("CONTINUITY CROSSED A PROJECT BOUNDARY");
    (await countFor(beta)) === 1 ? ok("exactly one, for that project") : bad("beta has the wrong count");

    console.log("");
    console.log("3. a thread ends eventually");
    /*
     * Without a window, every message he ever sends joins one conversation that
     * began in March. A working context, not a filing cabinet.
     */
    const tomorrow = await resolveConversation(pool, {
      channel: "whatsapp", projectId: alpha, now: mins(CONTINUITY_WINDOW_MINUTES + 60),
    });
    tomorrow.outcome === "created" && tomorrow.conversationId !== voice.conversationId
      ? ok(`past the ${CONTINUITY_WINDOW_MINUTES}-minute window, a new thread starts`)
      : bad("a day-old thread was continued");
    const justInside = await resolveConversation(pool, {
      channel: "phone", projectId: beta, now: mins(46 + CONTINUITY_WINDOW_MINUTES - 5),
    });
    justInside.conversationId === other.conversationId
      ? ok("while just inside it, the thread is still his")
      : bad("a thread inside the window was abandoned");

    console.log("");
    console.log("4. an explicit thread wins over the heuristic");
    const named = await resolveConversation(pool, {
      channel: "web", projectId: alpha,
      explicitConversationId: voice.conversationId,
      now: mins(CONTINUITY_WINDOW_MINUTES + 120),
    });
    named.conversationId === voice.conversationId && named.why.includes("named the thread")
      ? ok("opening an old thread by name continues it, whatever the window says")
      : bad("an explicitly named conversation was overridden by recency");

    console.log("");
    console.log("5. the global thread continues with itself");
    /*
     * project_id IS NULL is where system-level conversation lives. A plain `=`
     * comparison makes NULL match nothing, so every global message would create
     * a fresh conversation - the same bug as the per-channel one, arriving
     * through SQL semantics rather than through a filter.
     */
    const g1 = await resolveConversation(pool, { channel: "phone", projectId: null, now: mins(500) });
    const g2 = await resolveConversation(pool, { channel: "whatsapp", projectId: null, now: mins(505) });
    g2.conversationId === g1.conversationId
      ? ok("two global messages share one thread rather than creating one each")
      : bad("the global thread does not continue with itself");
    await pool.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`,
      [[g1.conversationId, g2.conversationId]]);
  } finally {
    await pool.query(`DELETE FROM conversations WHERE project_id = ANY($1::uuid[])`, [[alpha, beta]]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[alpha, beta]]);
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
