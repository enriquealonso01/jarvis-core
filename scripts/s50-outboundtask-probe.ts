/**
 * Adversarial probe of the outbound booking call (S50).
 *
 * "Jarvis calls a stranger and makes a commitment in his name." The rules under
 * test are the file's own four: the grant is a ceiling not a target, it
 * identifies without impersonating, it discloses only what the task needs, and
 * it never commits money.
 */
import {
  deviationsFrom, decideOnOffer, openingLine, disclosureFor, requestLine,
  cardRequested, mayDial, approvalForCall, recordingPolicy, MAX_ATTEMPTS,
  type BookingParameters, type CallOrigin,
} from "../src/outboundtask.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const GRANTED: BookingParameters = {
  when: "Saturday 8:00pm", partySize: 4, seating: "inside", underName: "Alonso",
};

console.log("\n== the grant is a ceiling, not a target ==");
ok("the exact offer is accepted",
  decideOnOffer(GRANTED, { when: "Saturday 8:00pm", partySize: 4, seating: "inside" }).act === "accept");
ok("casing and padding are the same offer",
  decideOnOffer(GRANTED, { when: "  saturday 8:00PM ", partySize: 4, seating: "INSIDE" }).act === "accept");
for (const [label, offer] of [
  ["a later time", { when: "Saturday 8:45pm", partySize: 4, seating: "inside" }],
  ["an earlier time", { when: "Saturday 7:30pm", partySize: 4, seating: "inside" }],
  ["another day", { when: "Sunday 8:00pm", partySize: 4, seating: "inside" }],
  ["a bigger table", { when: "Saturday 8:00pm", partySize: 6, seating: "inside" }],
  ["a smaller table", { when: "Saturday 8:00pm", partySize: 2, seating: "inside" }],
  ["different seating", { when: "Saturday 8:00pm", partySize: 4, seating: "terrace" }],
  ["seating dropped", { when: "Saturday 8:00pm", partySize: 4, seating: null }],
] as [string, any][]) {
  const d = decideOnOffer(GRANTED, offer);
  ok(`${label} stops and asks`, d.act === "stop_and_ask", JSON.stringify(d));
}
const near = decideOnOffer(GRANTED, { when: "Saturday 8:45pm", partySize: 4, seating: "inside" });
ok("the question names what changed",
  near.act === "stop_and_ask" && near.reportToHim.includes("8:45pm") && near.reportToHim.includes("8:00pm"),
  near.act === "stop_and_ask" ? near.reportToHim : "");
ok("and it does not haggle on the call",
  near.act === "stop_and_ask" && /call you back/i.test(near.say));

console.log("\n== money is a stop, not a deviation to weigh ==");
const carded = decideOnOffer(GRANTED, { when: "Saturday 8:00pm", partySize: 4, seating: "inside", requiresCard: true });
ok("an otherwise-perfect offer needing a card still stops", carded.act === "stop_and_ask", JSON.stringify(carded));
ok("nothing was given", carded.act === "stop_and_ask" && /not given them anything|can't give card/i.test(
  `${carded.say} ${carded.reportToHim}`));
ok("the standing refusal gives nothing", cardRequested().give === false);
ok("no disclosure field can hold a card",
  !("card" in disclosureFor(GRANTED)) && Object.keys(disclosureFor(GRANTED)).sort().join(",")
    === "partySize,seating,underName,when");

console.log("\n== it identifies, it does not impersonate ==");
const open = openingLine("Enrique Alonso");
ok("names Jarvis", /this is Jarvis/i.test(open));
ok("says it is automated", /automated/i.test(open));
ok("speaks on behalf of him", /on behalf of Enrique Alonso/i.test(open));
ok("never claims to be him", !/^Hello[ ,-]*this is Enrique/i.test(open), open);

console.log("\n== the request says only what the task needs ==");
const line = requestLine(disclosureFor(GRANTED));
ok("names party size, time, seating, name",
  line.includes("4") && line.includes("Saturday 8:00pm") && line.includes("inside") && line.includes("Alonso"));
ok("unspecified seating is simply absent",
  !requestLine(disclosureFor({ ...GRANTED, seating: null })).includes("null"),
  requestLine(disclosureFor({ ...GRANTED, seating: null })));

console.log("\n== approval ==");
ok("a call he named asks nothing", approvalForCall("he_named_it").asks === false);
ok("a call Jarvis chose asks", approvalForCall("jarvis_chose_it").asks === true);
for (const junk of ["constructor", "__proto__", "HE_NAMED_IT", "", "he_named_it "]) {
  ok(`${JSON.stringify(junk)} asks`, approvalForCall(junk as CallOrigin).asks === true);
}

console.log("\n== dialling: the one guard against calling a stranger in a loop ==");
ok(`first attempt allowed`, mayDial(0).dial === true);
ok(`second attempt allowed`, mayDial(1).dial === true);
ok(`third refused`, mayDial(MAX_ATTEMPTS).dial === false);
ok(`beyond refused`, mayDial(99).dial === false);
console.log("  -- counters that are not a count --");
for (const bad of [NaN, undefined, null, -1, "" as any]) {
  const d = mayDial(bad as number);
  const nextIsUsable = d.dial === false || Number.isInteger((d as any).attempt);
  ok(`mayDial(${JSON.stringify(bad) ?? String(bad)}) cannot start an endless loop`,
    nextIsUsable, JSON.stringify(d));
}

console.log("\n== recording ==");
ok("never records the other party", recordingPolicy().recordOtherParty === false);
ok("records its own side", recordingPolicy().recordOwnSide === true);

console.log(`==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
