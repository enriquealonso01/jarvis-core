/**
 * S50 — Jarvis calls a stranger and makes a commitment in his name.
 *
 * The plan supplies the assertion that matters and the reason it matters:
 *
 *   "**The deviation test**: the restaurant has nothing at eight, only 8:45 →
 *    Jarvis does **not** book 8:45. It comes back and asks."
 *
 *   "If it books the wrong slot when the exact one is unavailable, **the grant is
 *    being treated as a target to satisfy rather than a ceiling** — a miss is a
 *    question, not an improvisation."
 *
 * And it says where to look, twice:
 *
 *   "**Assert on what was synthesised on the call, not on a lucky paraphrase.**"
 *
 * So every assertion about what Jarvis said is made against the spoken lines, and
 * the impersonation check greps them rather than checking a flag that says
 * impersonation is off.
 */
import {
  approvalForCall, cardRequested, decideOnOffer, deviationsFrom, disclosureFor,
  mayDial, MAX_ATTEMPTS, openingLine, recordingPolicy, requestLine,
  type BookingParameters,
} from "../src/outboundtask.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** "Book a table for two Saturday at eight, inside." */
const GRANTED: BookingParameters = {
  when: "Saturday at 8pm",
  partySize: 2,
  seating: "inside",
  underName: "Enrique",
};

function main(): void {
  console.log("1. the call he asked for");
  const opening = openingLine("Enrique");
  const request = requestLine(disclosureFor(GRANTED));
  const spoken = [opening, request].join(" ");
  opening.includes("on behalf of Enrique")
    ? ok(`it identifies: "${opening}"`)
    : bad(`opening: ${opening}`);
  /*
   * "Grep the transcript: Jarvis never claims to BE Enrique." Asserted against
   * what was synthesised, not against a flag.
   */
  !/\b(I am|I'm|this is) Enrique\b/i.test(spoken)
    ? ok("and never claims to be him")
    : bad(`IT IMPERSONATED HIM: ${spoken}`);
  /(automated assistant|AI assistant)/i.test(opening)
    ? ok("with the automated-assistant disclosure on connect")
    : bad("the AI disclosure is missing from the opening line");
  request.includes("table for 2") && request.includes("Saturday at 8pm") && request.includes("inside")
    ? ok(`asking for exactly the granted parameters: "${request}"`)
    : bad(`request: ${request}`);

  console.log("");
  console.log("2. it discloses only what the task needs");
  const disclosure = disclosureFor(GRANTED);
  const fields = Object.keys(disclosure).sort().join(",");
  fields === "partySize,seating,underName,when"
    ? ok(`the disclosure carries four fields and no others: ${fields}`)
    : bad(`disclosure: ${fields}`);
  !/card|email|address|phone|account|other/i.test(fields)
    ? ok("with nowhere to put a card, an address or anything about his other affairs")
    : bad("the disclosure has a field it should not");
  /*
   * The Debug note: "if it discloses more than the task needs, it is applying
   * inbound disclosure rules to an outbound stranger". The way not to do that is
   * to have nothing else in scope.
   */
  !JSON.stringify(disclosure).includes("Enrique Alonso")
    ? ok("and it gives a first name, not everything it knows about him")
    : bad("the disclosure over-identified him");

  console.log("");
  console.log("3. the deviation test");
  /*
   * THE ASSERTION THE PLAN CALLS FOR. Nothing at eight, only 8:45.
   */
  const late = decideOnOffer(GRANTED, { when: "Saturday at 8:45pm", partySize: 2, seating: "inside" });
  late.act === "stop_and_ask"
    ? ok("nothing at eight, only 8:45 — it does not book it")
    : bad("IT BOOKED AN UNAUTHORISED SLOT");
  late.act === "stop_and_ask" && late.deviations[0]?.field === "time"
    ? ok(`and names what changed: ${JSON.stringify(late.deviations)}`)
    : bad("the deviation is not named");
  late.act === "stop_and_ask" && late.reportToHim.includes("8:45") && late.reportToHim.includes("?")
    ? ok(`coming back with a question rather than a problem: "${late.reportToHim}"`)
    : bad(`report: ${late.act === "stop_and_ask" ? late.reportToHim : ""}`);
  /*
   * What it says ON THE CALL matters too: it must not accept, and must not
   * negotiate a booking it has no authority for.
   */
  /*
   * He reads these. "They can do time Saturday at 8:45pm" is what naive field
   * labelling produces, and a report that reads like a form makes him place the
   * call himself to find out what happened.
   */
  late.act === "stop_and_ask" && !/do time /i.test(late.reportToHim)
    ? ok("and the report reads like a sentence, not a form")
    : bad(`the report reads like a form: ${late.act === "stop_and_ask" ? late.reportToHim : ""}`);
  late.act === "stop_and_ask" && !/please hold|book|reserve/i.test(late.say)
    ? ok(`and says nothing on the call that commits him: "${late.say}"`)
    : bad(`it committed on the call: ${late.say}`);

  /*
   * Both halves, or the guard proves only that it never books anything.
   */
  const exact = decideOnOffer(GRANTED, { when: "Saturday at 8pm", partySize: 2, seating: "inside" });
  exact.act === "accept"
    ? ok("while the exact table he asked for is taken")
    : bad("it refused the booking he actually authorised");

  console.log("");
  console.log("4. every parameter is a ceiling, not just the time");
  const bigger = decideOnOffer(GRANTED, { when: "Saturday at 8pm", partySize: 4, seating: "inside" });
  bigger.act === "stop_and_ask"
    ? ok("a larger party than he asked for is a deviation too")
    : bad("it booked a bigger table");
  const outside = decideOnOffer(GRANTED, { when: "Saturday at 8pm", partySize: 2, seating: "outside" });
  outside.act === "stop_and_ask"
    ? ok("and so is the wrong seating, which he stated")
    : bad("it accepted seating he did not ask for");
  deviationsFrom(GRANTED, { when: "saturday at 8PM ", partySize: 2, seating: " Inside" }).length === 0
    ? ok("while case and spacing are not deviations, so it does not stop over nothing")
    : bad("a whitespace difference was treated as a deviation");

  console.log("");
  console.log("5. the commitment test");
  const deposit = decideOnOffer(GRANTED, {
    when: "Saturday at 8pm", partySize: 2, seating: "inside", requiresCard: true,
  });
  deposit.act === "stop_and_ask"
    ? ok("a booking needing a card deposit stops, even though the table is exactly right")
    : bad("IT PROCEEDED WITH A CARD DEPOSIT");
  deposit.act === "stop_and_ask" && !/\d{4}/.test(deposit.say)
    ? ok(`and nothing resembling a card number is said: "${deposit.say}"`)
    : bad(`digits were spoken: ${deposit.act === "stop_and_ask" ? deposit.say : ""}`);
  const asked = cardRequested();
  asked.give === false && !/\d/.test(asked.say)
    ? ok(`asked directly for a card, it refuses with no digits at all: "${asked.say}"`)
    : bad(`card response: ${JSON.stringify(asked)}`);
  asked.report.includes("did not give")
    ? ok("and tells him it was asked and refused, so he can decide")
    : bad("the card request was not reported");

  console.log("");
  console.log("6. explicit instruction is approval, and only for what he said");
  const his = approvalForCall("he_named_it");
  !his.asks
    ? ok(`the call he asked for raises no redundant approval: "${his.why}"`)
    : bad("it asked again about the thing he just asked for");
  const chosen = approvalForCall("jarvis_chose_it");
  chosen.asks
    ? ok("while a second place he did not name does raise one")
    : bad("Jarvis called somewhere he chose without asking");
  chosen.why.includes("does not inherit")
    ? ok("because a choice does not inherit the authority of an instruction")
    : bad("the reason does not hold the rule");

  console.log("");
  console.log("7. it does not redial in a loop");
  mayDial(0).dial && mayDial(1).dial
    ? ok(`two attempts are allowed (MAX_ATTEMPTS ${MAX_ATTEMPTS})`)
    : bad("it will not even try twice");
  const third = mayDial(2);
  !third.dial
    ? ok("and a third is refused")
    : bad("IT WOULD KEEP CALLING THEM");
  !third.dial && third.report.includes("stopped")
    ? ok(`reporting back rather than going quiet: "${third.report}"`)
    : bad("it stopped without telling him");

  console.log("");
  console.log("8. it does not record the other party");
  const policy = recordingPolicy();
  policy.recordOtherParty === false && policy.recordOwnSide
    ? ok("Jarvis's own side is transcribed; the other party's audio is not recorded")
    : bad(`recording policy: ${JSON.stringify(policy)}`);
  policy.why.includes("jurisdiction")
    ? ok("and the reason is the one the plan flagged, so changing it is a decision not an accident")
    : bad("the recording default carries no reason");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
