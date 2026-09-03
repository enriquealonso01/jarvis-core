/**
 * S43 — change anything by asking, from whichever channel he is on.
 *
 * Two properties carry this step and both are stated as traps.
 *
 *   "Communication preferences are stored, versioned, and **actually consulted**
 *    — a preference nothing reads is a preference that does not exist."
 *
 * So nothing here asserts that a row was written. Every preference assertion goes
 * through `composeReply`, which is an OUTPUT: change the preference, the reply
 * changes. A suite that checked the table would pass on a system where nothing
 * ever read it, which is precisely the failure being named.
 *
 *   "**A UI change touching the approval flow stops for confirmation**, even when
 *    phrased as tidying. A change to the queue's ordering does not. **That pair
 *    is the test** — one without the other proves only that the gate is stuck in
 *    one position."
 *
 * So it is asserted as a pair, in both directions, every time.
 */
import { createPool } from "../src/db.js";
import {
  addressAs, composeReply, DEFAULT_ADDRESS, DETAIL_BUDGETS, detailBudgetFor,
  preferenceFor, rollbackPreference, setPreference,
} from "../src/prefs.js";
import { consoleChangeGate, COSMETIC_AREAS, owningSurface } from "../src/consolechange.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const KEYS = ["comm.address_as", "comm.detail_level"];
const LONG = "A ".repeat(900);

async function main(): Promise<void> {
  await pool.query(`DELETE FROM config_versions WHERE scope = 'global' AND key = ANY($1)`, [KEYS]);
  try {
    console.log("1. said by phone, audible on the next call");
    (await addressAs(pool, "phone")) === DEFAULT_ADDRESS
      ? ok(`before he says anything it is "${DEFAULT_ADDRESS}"`)
      : bad("the default address is not what S19 used");
    await setPreference(pool, {
      key: "comm.address_as", value: "Enri", channel: "phone",
      causedByMessage: "stop calling me Enrique in voice calls, use my first name only",
    });
    (await addressAs(pool, "phone")) === "Enri"
      ? ok("after one sentence on the phone, the phone greeting changes")
      : bad(`the phone still says ${await addressAs(pool, "phone")}`);
    (await addressAs(pool, "whatsapp")) === DEFAULT_ADDRESS
      ? ok("and only the phone — he narrowed it to voice calls")
      : bad("a change meant for voice reached WhatsApp");

    console.log("");
    console.log("2. 'be more detailed in chat but keep WhatsApp short'");
    /*
     * Two sentences about two channels are two edits to ONE preference. The
     * second must not discard the first, which is what a replace-the-value
     * implementation does.
     */
    await setPreference(pool, { key: "comm.detail_level", value: "detailed", channel: "web" });
    await setPreference(pool, { key: "comm.detail_level", value: "short", channel: "whatsapp" });
    const web = await composeReply(pool, "web", LONG);
    const wa = await composeReply(pool, "whatsapp", LONG);
    web.budget === DETAIL_BUDGETS.detailed && wa.budget === DETAIL_BUDGETS.short
      ? ok(`both are honoured at once: web ${web.budget}, whatsapp ${wa.budget}`)
      : bad(`web ${web.budget}, whatsapp ${wa.budget} — the second edit discarded the first`);
    /*
     * ACTUALLY CONSULTED. Asserted on the reply, not on the row: a preference
     * nothing reads is a preference that does not exist, and the table cannot
     * tell the difference.
     */
    web.text.length > wa.text.length && wa.text.length <= DETAIL_BUDGETS.short
      ? ok("and the replies themselves differ in length, which is the only proof that counts")
      : bad(`replies: web ${web.text.length}, whatsapp ${wa.text.length}`);
    (await composeReply(pool, "phone", LONG)).budget === DETAIL_BUDGETS.normal
      ? ok("while a channel he never mentioned keeps the default")
      : bad("an unmentioned channel picked up somebody else's setting");

    console.log("");
    console.log("3. the preference belongs to him, not to the transport");
    /*
     * The Debug note: "if preferences apply on one channel and not another, they
     * are being read at the wrong layer. Preferences belong to the conversation
     * and the user, not to the transport." A preference set with no channel in
     * mind must reach every surface he has not overridden.
     */
    await setPreference(pool, { key: "comm.address_as", value: "boss" });
    const everywhere = await Promise.all(
      ["web", "console", "sms"].map((c) => addressAs(pool, c)));
    everywhere.every((v) => v === "boss")
      ? ok("a general preference reaches every surface with no opinion of its own")
      : bad(`reached ${everywhere.join(", ")}`);
    (await addressAs(pool, "phone")) === "Enri"
      ? ok("and does not overwrite the one surface he was specific about")
      : bad("the general setting clobbered the phone-specific one");
    (await preferenceFor(pool, "comm.address_as", "phone")).from === "channel"
      && (await preferenceFor(pool, "comm.address_as", "web")).from === "default"
      ? ok("and the resolver says which layer answered, so a wrong one is diagnosable")
      : bad("the resolution does not report its layer");

    console.log("");
    console.log("4. roll one back and previous behaviour returns exactly");
    const beforeRollback = await addressAs(pool, "web");
    const rolled = await rollbackPreference(pool, "comm.address_as");
    const afterRollback = await addressAs(pool, "web");
    rolled && afterRollback === DEFAULT_ADDRESS && beforeRollback === "boss"
      ? ok(`"boss" rolls back to "${afterRollback}" — the previous behaviour, exactly`)
      : bad(`rollback gave ${afterRollback}`);
    (await addressAs(pool, "phone")) === "Enri"
      ? ok("and the phone override, set before that version, survives it")
      : bad("rolling back one change undid an unrelated earlier one");
    /*
     * Rolled FORWARD as a new version rather than by deleting the current row,
     * so what was in force between the two changes stays explicable. Deleting
     * makes the rollback invisible and the audit wrong about the period.
     */
    /*
     * Counted as a PROPERTY rather than against a number: the first version of
     * this asserted "4" and the truth was 3, which is an arithmetic mistake in
     * the test dressed up as a finding. What matters is that the rollback ADDED
     * a version and the undone one is still there - deleting would make the
     * rollback invisible and the audit wrong about what was in force between the
     * two changes.
     */
    const history = (await pool.query<{ version: number; value: { default: string | null } }>(
      `SELECT version, value FROM config_versions
        WHERE scope='global' AND key='comm.address_as' ORDER BY version`,
    )).rows;
    history.length >= 3 && history[history.length - 1].version > history[history.length - 2].version
      ? ok(`the rollback added version ${history[history.length - 1].version} rather than removing one`)
      : bad(`history: ${history.map((h) => h.version).join(", ")}`);
    history.some((h) => h.value.default === "boss")
      ? ok("and the version that was undone is still in the history, so the period stays explicable")
      : bad("the rollback erased what was in force before it");

    console.log("");
    console.log("5. the pair the plan calls the test");
    /*
     * "One without the other proves only that the gate is stuck in one
     * position", so both directions, every time.
     */
    const tidy = consoleChangeGate({ area: "approval_flow", request: "tidy up the approvals page" });
    const reorder = consoleChangeGate({ area: "ordering", request: "move the queue above the health strip" });
    tidy.confirm && !reorder.confirm
      ? ok("'tidy up the approvals page' confirms; 'move the queue above the health strip' does not")
      : bad(`approval=${tidy.confirm}, ordering=${reorder.confirm} — the gate is stuck`);
    tidy.why.includes("however it was asked for")
      ? ok("and the reason names why phrasing does not matter")
      : bad(`the reason is weak: ${tidy.why}`);
    tidy.project === "control-center" && reorder.project === "control-center"
      ? ok("both become tasks in the Control Center project either way")
      : bad("a console change did not land in the console project");

    console.log("");
    console.log("6. an unclassified part of the console is not assumed cosmetic");
    /*
     * An allow-list, not a deny-list, and this is the whole safety property: the
     * console will grow areas, and under a deny-list an unknown one is treated
     * as cosmetic. Here the cost of not having classified something is one
     * question.
     */
    for (const area of ["session", "auth", "a_page_nobody_has_classified", "billing"]) {
      consoleChangeGate({ area, request: "make it nicer" }).confirm
        ? ok(`${area} stops for confirmation`)
        : bad(`${area} was treated as cosmetic`);
    }
    COSMETIC_AREAS.every((a) => !consoleChangeGate({ area: a, request: "x" }).confirm)
      ? ok(`while all ${COSMETIC_AREAS.length} cosmetic areas proceed as ordinary work`)
      : bad("a cosmetic area is stuck asking");

    console.log("");
    console.log("7. he never has to know which subsystem owns it");
    const routes: [string, string][] = [
      ["stop calling me Enrique in voice calls", "preference"],
      ["move the queue above the health strip", "console_repo"],
      ["connect the supplier API", "connection"],
      ["run the sweep every day at seven", "schedule"],
    ];
    for (const [request, expected] of routes) {
      owningSurface(request) === expected
        ? ok(`"${request}" -> ${expected}`)
        : bad(`"${request}" -> ${owningSurface(request)}, expected ${expected}`);
    }
    /*
     * And it says so rather than guessing. A router that always picks something
     * will file a connection change as a UI task with complete confidence.
     */
    owningSurface("do the thing with the stuff") === "unknown"
      ? ok("and something it cannot place comes back unknown rather than guessed")
      : bad("an unplaceable request was routed anyway");

    console.log("");
    console.log("8. a key nothing would read is refused");
    let refused = false;
    try {
      await setPreference(pool, { key: "comm.favourite_colour", value: "blue" });
    } catch {
      refused = true;
    }
    refused
      ? ok("an unrecognised preference key is refused rather than written where nothing reads it")
      : bad("a preference was stored that nothing consults");
  } finally {
    await pool.query(`DELETE FROM config_versions WHERE scope = 'global' AND key = ANY($1)`, [KEYS]);
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
