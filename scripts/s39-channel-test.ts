/**
 * S39 — nothing unspeakable is ever spoken.
 *
 *   "**A URL never goes down the phone.** When a voice workflow needs one — an
 *    auth link, a PR, a document — Jarvis says it is sending it to WhatsApp,
 *    and sends it. **That sentence is part of the spoken flow, not an apology
 *    afterwards.**"
 *
 *   "Read a voice transcript aloud: no URL, no more than a couple of proper
 *    nouns, no paragraph that would be hard to follow at walking pace."
 *
 * Both halves are asserted together throughout, because they come apart in
 * opposite and equally bad ways: stripping the URL and saying nothing leaves
 * him waiting for a link that never arrives - worse than dictating it, since a
 * dictated URL at least tells him one exists - while saying the promise and not
 * queueing the message is a spoken lie.
 */
import { createPool } from "../src/db.js";
import { speakable, speakableWithLinks } from "../src/speakable.js";
import { queueUnprompted } from "../src/unprompted.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const AUTH_LINE =
  "I need you to sign in to the supplier portal. Open "
  + "https://jarvis.example.com/action/9f2c?t=Yy3kPq7sD2nE4vB8 and paste the key.";

async function main(): Promise<void> {
  try {
    console.log("1. an address never reaches the spoken line");
    const plan = speakableWithLinks(AUTH_LINE);
    !/https?:\/\//i.test(plan.say)
      ? ok("no scheme in what is spoken")
      : bad(`the spoken line contains a URL: "${plan.say}"`);
    !plan.say.includes("Yy3kPq7sD2nE4vB8")
      ? ok("and the token is not dictated aloud into whatever the room can hear")
      : bad("THE TOKEN WAS SPOKEN");
    /*
     * The regression this exists for. `speakable` strips markdown links and
     * left BARE urls alone, so an auth link with its token went down the phone
     * verbatim - confirmed against the real function before this change.
     */
    /https?:\/\//i.test(speakable(AUTH_LINE).say)
      ? ok("(the older speakable() still passes a bare URL through, which is why this exists)")
      : ok("speakable() no longer passes a bare URL either");

    console.log("");
    console.log("2. and the promise is part of the same breath");
    plan.say.includes("sending you the link on WhatsApp")
      ? ok(`it says where the link is going: "${plan.say}"`)
      : bad(`no promise in the spoken line: "${plan.say}"`);
    plan.links.length === 1 && plan.links[0].includes("Yy3kPq7sD2nE4vB8")
      ? ok("while the link itself comes back to the caller to deliver")
      : bad(`links extracted: ${JSON.stringify(plan.links)}`);
    /*
     * The half that would otherwise be silently missing: stripping the URL and
     * saying nothing satisfies "no URL was spoken" and leaves him waiting.
     */
    plan.links.length > 0 && plan.say.includes("WhatsApp")
      ? ok("both halves — nothing spoken, and something said about where it went")
      : bad("one half without the other");

    console.log("");
    console.log("3. shapes a phone cannot say");
    !speakableWithLinks("See www.example.com/x for details.").say.includes("example.com")
      ? ok("a bare www address is lifted out")
      : bad("www.example.com was spoken");
    !speakableWithLinks("Mail enrique@example.com about it.").say.includes("@")
      ? ok("and an email address, which is not followable at walking pace either")
      : bad("an email address was spoken");
    const bare = speakableWithLinks("Check jarvis.example.com/artifacts/7 later.");
    !bare.say.includes("jarvis.example.com")
      ? ok("and a schemeless host with a path")
      : bad(`a bare host was spoken: "${bare.say}"`);

    console.log("");
    console.log("4. a line with no address is left alone");
    const plain = speakableWithLinks("The deploy finished. Nothing needs you.");
    plain.say === "The deploy finished. Nothing needs you."
      ? ok("an ordinary sentence is unchanged")
      : bad(`a plain sentence was altered: "${plain.say}"`);
    plain.links.length === 0 && !plain.say.includes("WhatsApp")
      ? ok("and it does not promise a message nobody is sending")
      : bad("a promise was made with no link to send");

    console.log("");
    console.log("5. the promise survives the length cap");
    /*
     * Appended after the cap on purpose. A cap that can eat the sentence
     * explaining where the link went produces exactly the silence this rule
     * exists to prevent - and a long answer is precisely when a link is most
     * likely to be attached.
     */
    const longOne = speakableWithLinks(
      `${"The migration touched a great many files and each one needed checking. ".repeat(8)}`
      + "Open https://jarvis.example.com/pr/42 to review.",
    );
    longOne.truncated ? ok("a long answer is truncated") : bad("the fixture was not long enough to truncate");
    longOne.say.includes("WhatsApp")
      ? ok("and the promise is still there afterwards")
      : bad(`the cap ate the promise: "${longOne.say.slice(-90)}"`);
    !/https?:\/\//i.test(longOne.say)
      ? ok("with no address in the part that survived")
      : bad("a URL survived the truncation");

    console.log("");
    console.log("6. the link goes out through the closed list");
    await pool.query(`DELETE FROM unprompted_messages WHERE reason = 'auth_handoff'`);
    const q = await queueUnprompted(pool, {
      reason: "auth_handoff",
      subject: "the link from our call",
      link: plan.links[0],
      now: new Date("2026-09-04T17:00:00Z"),
    });
    q.verdict.send
      ? ok("queued as auth_handoff, a reason Jarvis may already open a conversation")
      : bad(`the handoff was refused: ${JSON.stringify(q.verdict)}`);
    const row = (await pool.query<{ link: string | null }>(
      `SELECT link FROM unprompted_messages WHERE id = $1`, [q.id])).rows[0];
    row?.link === plan.links[0]
      ? ok("carrying the exact link that was lifted out of the call")
      : bad(`the queued link is ${row?.link}`);
  } finally {
    await pool.query(`DELETE FROM unprompted_messages WHERE reason = 'auth_handoff'`);
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
