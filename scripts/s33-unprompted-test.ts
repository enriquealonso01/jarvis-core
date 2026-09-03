/**
 * S33 — the messages Jarvis starts, and the ones it must not.
 *
 * The plan names the assertion that matters:
 *
 *   "Trigger every source of an unprompted message, and confirm only the listed
 *    reasons produce one. **The assertion that matters is the absence** — a test
 *    that only proves the six work would pass on a system that also sends nine
 *    others."
 *
 * So the list is asserted in both directions: every listed reason is allowed,
 * and a set of plausible unlisted ones - each of which some future feature
 * would reasonably want - is refused.
 *
 * And the quiet-hours half, which the plan describes as a routing bug rather
 * than a missing feature: S23 blocks a CALL at 03:00 and the call "becomes a
 * WhatsApp", so the rule that stops the phone ringing "routes the interruption
 * to the same phone by a different route. It buzzes instead of ringing, which
 * is not what quiet hours means to the person asleep next to it."
 */
import { createPool } from "../src/db.js";
import { QUIET_HOURS_OVERRIDE } from "../src/outbound.js";
import { inQuietHours } from "../src/policy.js";
import {
  drainUnprompted, mayOpenConversation, mayReply, queueUnprompted, UNPROMPTED_REASONS,
} from "../src/unprompted.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** 21:00 and 02:00 in America/New_York, as instants. */
const NIGHT = new Date("2026-09-04T01:00:00Z");   // 21:00 EDT the previous day
const SMALL_HOURS = new Date("2026-09-04T06:00:00Z"); // 02:00 EDT
const DAYTIME = new Date("2026-09-04T17:00:00Z");  // 13:00 EDT

async function main(): Promise<void> {
  try {
    console.log("0. the fixture times are what this suite thinks they are");
    inQuietHours(NIGHT) && inQuietHours(SMALL_HOURS) && !inQuietHours(DAYTIME)
      ? ok("21:00 and 02:00 are inside quiet hours, 13:00 is not")
      : bad(`quiet hours disagree: night=${inQuietHours(NIGHT)} small=${inQuietHours(SMALL_HOURS)} day=${inQuietHours(DAYTIME)}`);

    console.log("");
    console.log("1. every listed reason may open a conversation");
    const listed = Object.keys(UNPROMPTED_REASONS);
    listed.every((r) => mayOpenConversation(r, DAYTIME).send)
      ? ok(`all ${listed.length} listed reasons are allowed in the daytime: ${listed.join(", ")}`)
      : bad(`a listed reason was refused: ${listed.filter((r) => !mayOpenConversation(r, DAYTIME).send).join(", ")}`);

    console.log("");
    console.log("2. and nothing else does — the assertion that matters");
    /*
     * Each of these is something a future feature would plausibly want to send,
     * which is the point: the list has to refuse reasonable-sounding additions,
     * not just obvious nonsense.
     */
    const unlisted = [
      "task_finished", "build_green", "deploy_succeeded", "daily_digest",
      "model_switched", "backup_completed", "new_document_indexed",
      "scrape_finished", "cost_report", "someone_mentioned_you",
    ];
    const leaked = unlisted.filter((r) => mayOpenConversation(r, DAYTIME).send);
    leaked.length === 0
      ? ok(`ten plausible unlisted reasons are all refused (${unlisted.length} tried)`)
      : bad(`these got through: ${leaked.join(", ")}`);
    const why = mayOpenConversation("deploy_succeeded", DAYTIME);
    !why.send && why.why.includes("not a reason")
      ? ok(`and the refusal says so: "${why.why}"`)
      : bad("an unlisted reason was refused without saying why");

    console.log("");
    console.log("3. quiet hours hold what Jarvis starts");
    const held = mayOpenConversation("blocker", NIGHT);
    !held.send && "sendAfter" in held
      ? ok(`a blocker at 21:00 is held until ${held.sendAfter.toISOString()}`)
      : bad(`a blocker at 21:00 was sent: ${JSON.stringify(held)}`);
    !held.send && "sendAfter" in held && held.sendAfter > NIGHT
      ? ok("which is later than when it was wanted, not immediately")
      : bad("the hold does not move the send time forward");

    console.log("");
    console.log("4. the one override, and it is S23's object");
    const security = mayOpenConversation("security_event", NIGHT);
    security.send
      ? ok(`a security event at 21:00 goes: "${security.why}"`)
      : bad("a security event was held through the night");
    /*
     * "Two override lists diverge and the looser one wins." So the WhatsApp
     * reasons do not carry their own override flag - they name an S23 reason,
     * and this asserts that the set which overrides is exactly the set S23
     * overrides for.
     */
    const overriding = Object.entries(UNPROMPTED_REASONS)
      .filter(([, v]) => v.escalatesAs && QUIET_HOURS_OVERRIDE.includes(v.escalatesAs))
      .map(([k]) => k);
    overriding.join(",") === "security_event"
      ? ok("exactly one unprompted reason overrides, and it does so via the list the phone reads")
      : bad(`the overriding reasons are ${overriding.join(", ")}`);
    QUIET_HOURS_OVERRIDE.length === 1
      ? ok("and that list still has one entry, so there is no second exception to drift")
      : bad(`S23's override list has grown to ${QUIET_HOURS_OVERRIDE.length}`);

    console.log("");
    console.log("5. a reply at 02:00 is answered at 02:00");
    mayReply(SMALL_HOURS).send && mayReply(NIGHT).send
      ? ok("asked AT 02:00 and at 21:00, a reply still goes — quiet hours govern what Jarvis starts, never what he starts")
      : bad("a reply was silenced by quiet hours");

    console.log("");
    console.log("6. three items in a window are one message with three lines");
    await pool.query(`DELETE FROM unprompted_messages`);
    await queueUnprompted(pool, { reason: "blocker", subject: "the deploy key is missing", link: "https://j/x/1", now: DAYTIME });
    await queueUnprompted(pool, { reason: "proposal", subject: "I could add a nightly backup check", now: DAYTIME });
    await queueUnprompted(pool, { reason: "auth_handoff", subject: "sign in to the supplier portal", link: "https://j/x/3", now: DAYTIME });
    const batch = await drainUnprompted(pool, DAYTIME);
    batch?.lines.length === 3
      ? ok(`three items became one message with three lines:\n         ${batch.lines.join("\n         ")}`)
      : bad(`the batch has ${batch?.lines.length} line(s)`);
    batch?.lines.filter((l) => l.includes("https://j/x/")).length === 2
      ? ok("and each link is on the line it belongs to, not one at the bottom")
      : bad("the links are not attached to their own items");
    const again = await drainUnprompted(pool, DAYTIME);
    again === null
      ? ok("a second drain sends nothing, so a quiet morning is silent rather than empty")
      : bad("draining twice produced a second message");

    console.log("");
    console.log("7. a held item is recorded immediately, and goes out in the morning");
    await pool.query(`DELETE FROM unprompted_messages`);
    const q = await queueUnprompted(pool, { reason: "blocker", subject: "waiting on you", now: NIGHT });
    const row = (await pool.query<{ send_after: string; sent_at: string | null }>(
      `SELECT send_after::text, sent_at::text FROM unprompted_messages WHERE id = $1`, [q.id])).rows[0];
    row && row.sent_at === null
      ? ok("the row exists at 21:00, so the console is accurate at 06:00 if he looks")
      : bad("nothing was recorded, or it was sent");
    (await drainUnprompted(pool, NIGHT)) === null
      ? ok("and draining during the night sends nothing")
      : bad("a held message went out at 21:00");
    const morning = new Date(new Date(row.send_after).getTime() + 60_000);
    (await drainUnprompted(pool, morning))?.lines.length === 1
      ? ok("while draining after 08:00 sends it")
      : bad("the held message never went out");

    console.log("");
    console.log("8. an unlisted reason is recorded as refused, not dropped");
    await pool.query(`DELETE FROM unprompted_messages`);
    const refused = await queueUnprompted(pool, { reason: "deploy_succeeded", subject: "prod is up", now: DAYTIME });
    !refused.verdict.send ? ok("it is not sent") : bad("an unlisted reason was sent");
    const kept = (await pool.query<{ refused_reason: string | null }>(
      `SELECT refused_reason FROM unprompted_messages WHERE id = $1`, [refused.id])).rows[0];
    kept?.refused_reason
      ? ok(`but it is on the record: "${kept.refused_reason}"`)
      : bad("a refused message left no trace, so a caller ignoring the result hides it");
    (await drainUnprompted(pool, DAYTIME)) === null
      ? ok("and a refused row is never drained into a message")
      : bad("a refused message was sent by the drain");
  } finally {
    await pool.query(`DELETE FROM unprompted_messages`);
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
