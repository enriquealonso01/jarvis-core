/**
 * S39, wired: the live spoken answer no longer dictates a URL.
 *
 * S39's rule — "**a URL never goes down the phone**" — shipped with
 * `speakableWithLinks`, and the live answer path went on calling the old
 * `speakable()`. S39's own evidence records why that matters, because the
 * regression was real and was measured:
 *
 *   "speakable() stripped markdown links and left BARE ones alone, so an auth
 *    link went down the line verbatim... 'Open https://…?t=Yy3kPq7sD2nE4vB8 and
 *    paste the key' was spoken in full, which is a one-time token dictated aloud
 *    into whatever the room can hear."
 *
 * So this asserts against `speakable` and `speakableWithLinks` side by side —
 * proving the OLD one still leaks, which is what makes the swap a fix rather than
 * a refactor — and then asserts both halves of the replacement together, because
 * they come apart in opposite and equally bad ways: stripping the URL and saying
 * nothing leaves him waiting for a link that never arrives, and promising it
 * without sending is a spoken lie.
 */
import fs from "node:fs/promises";
import { createPool } from "../src/db.js";
import { speakable, speakableWithLinks } from "../src/speakable.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/* Built from a char code: an escape here has been eaten five times now. */
const NEWLINE = String.fromCharCode(10);
const TOKEN = "Yy3kPq7sD2nE4vB8";
const ANSWER =
  "I need you to sign in to the supplier portal. Open "
  + `https://jarvis.example.com/action/9f2c?t=${TOKEN} and paste the key.`;

async function main(): Promise<void> {
  try {
    console.log("1. the function the live path used to call still leaks");
    /*
     * Not a formality. If speakable() had quietly been fixed, the swap would be
     * a no-op and this suite would be asserting nothing - so the leak is proven
     * to exist before the fix is credited with removing it.
     */
    /https?:\/\//i.test(speakable(ANSWER).say)
      ? ok("speakable() still passes a bare URL straight through to the line")
      : bad("speakable() no longer leaks, so this suite proves nothing about the swap");
    speakable(ANSWER).say.includes(TOKEN)
      ? ok(`including the one-time token: ${TOKEN}`)
      : bad("the token is not in the old rendering, so the fixture is wrong");

    console.log("");
    console.log("2. what the live path calls now");
    const plan = speakableWithLinks(ANSWER);
    !/https?:\/\//i.test(plan.say) && !plan.say.includes(TOKEN)
      ? ok(`no address and no token in what is spoken: "${plan.say}"`)
      : bad(`THE LIVE PATH WOULD STILL SPEAK IT: ${plan.say}`);
    plan.say.includes("WhatsApp")
      ? ok("and it says where the link is going, in the same breath")
      : bad("it strips the link and says nothing, which leaves him waiting");
    plan.links.length === 1 && plan.links[0].includes(TOKEN)
      ? ok("while the link itself comes back for delivery")
      : bad(`links: ${JSON.stringify(plan.links)}`);

    console.log("");
    console.log("3. the promise is kept — the outbox actually carries it");
    /*
     * The half that makes the promise true. Asserted on the outbox rows the live
     * path writes, keyed the way it keys them, because "saying the promise and
     * not queueing the message is a spoken lie".
     */
    const turnId = `s39w-${Math.random().toString(36).slice(2, 8)}`;
    const { enqueueNotification } = await import("../src/notify.js");
    for (const [i, link] of plan.links.entries()) {
      await enqueueNotification(pool, {
        level: "whatsapp_degraded",
        messageType: "status",
        body: link,
        objectType: "call_turn",
        idempotencyKey: `call-link:${turnId}:${i}`,
      });
    }
    const rows = (await pool.query<{ channel: string; body: string }>(
      `SELECT channel, body FROM notifications_outbox WHERE idempotency_key LIKE $1`,
      [`call-link:${turnId}:%`])).rows;
    rows.some((r) => r.channel === "whatsapp" && r.body.includes(TOKEN))
      ? ok("a WhatsApp row carries the exact link that was lifted out of the call")
      : bad(`outbox: ${JSON.stringify(rows)}`);
    rows.some((r) => r.channel === "ui")
      ? ok("and the console gets it too, so it is not only on his phone")
      : bad("the link reached WhatsApp only");

    /*
     * Idempotent on the turn: a retried turn must not send the same link twice,
     * which is the failure S37's outbox discipline exists to prevent.
     */
    const before = rows.length;
    await enqueueNotification(pool, {
      level: "whatsapp_degraded", messageType: "status", body: plan.links[0],
      objectType: "call_turn", idempotencyKey: `call-link:${turnId}:0`,
    });
    const after = Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications_outbox WHERE idempotency_key LIKE $1`,
      [`call-link:${turnId}:%`])).rows[0].n);
    after === before
      ? ok("and a retried turn does not queue the same link a second time")
      : bad(`${after} rows after a retry, was ${before}`);

    await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`,
      [`call-link:${turnId}:%`]);

    console.log("");
    console.log("4. and it is the LIVE path that does this, not this test");
    /*
     * The assertions above exercise the same functions callruntime calls, which
     * is not the same as asserting that callruntime calls them - sabotaging the
     * live path left every one of them green. That is the "asserting the rule,
     * not the wiring" mistake, and the repo already has the answer: read the
     * source, the way s27-config-test holds "only one file writes a version row".
     */
    const runtime = await fs.readFile(new URL("../src/callruntime.ts", import.meta.url), "utf8");
    /speakableWithLinks\(written\)/.test(runtime)
      ? ok("the live answer path renders with speakableWithLinks")
      : bad("callruntime does not call speakableWithLinks on the answer");
    /*
     * Comment lines are excluded. The prose in callruntime explains WHY
     * speakable() was wrong, so a naive search finds the explanation and calls
     * it a violation - and the version of this assertion with a broken escape
     * matched nothing at all, so it had never once evaluated. It does now.
     */
    const code = runtime.split(NEWLINE)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(NEWLINE);
    !new RegExp("\\bspeakable\\(").test(code)
      ? ok("and never calls the leaking speakable() at all")
      : bad("callruntime still calls speakable(), which passes bare URLs through");
    /spokenForm\.links/.test(runtime)
      ? ok("it delivers the links it lifted rather than dropping them")
      : bad("the lifted links are never delivered, so the promise is a lie");
    /*
     * Order matters: queued BEFORE the line is spoken, so the sentence is true by
     * the time he hears it and a call dropping mid-answer still delivers.
     */
    runtime.indexOf("call-link:") < runtime.indexOf('saySafely(t, ctx, answer, "answer")')
      ? ok("and queues them before the line is spoken, not after")
      : bad("the link is queued after the answer, so the promise is briefly false");
    /*
     * The key must be stable across a retry. A clock in it makes every retry a
     * new row, which is the duplicate this idempotency exists to prevent.
     */
    !/call-link:[^`]*Date\.now|call-link:[^`]*Math\.random/.test(runtime)
      ? ok("with an idempotency key that has no clock in it, so a retry collides")
      : bad("the idempotency key varies per attempt, so a retry sends twice");

    console.log("");
    console.log("5. an answer with no link promises nothing");
    const plain = speakableWithLinks("The deploy finished. Nothing needs you.");
    plain.links.length === 0 && !plain.say.includes("WhatsApp")
      ? ok("an ordinary answer is unchanged and makes no promise nobody is keeping")
      : bad(`a plain answer produced ${JSON.stringify(plain)}`);
  } finally {
    await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE 'call-link:s39w-%'`);
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
