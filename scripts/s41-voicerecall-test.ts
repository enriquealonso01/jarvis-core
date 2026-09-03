/**
 * S41 — recall on a phone call, and the three endpoints a call actually is.
 *
 * The plan is unusually specific about where to look:
 *
 *   "Ask for a confidential report by voice -> it names it, gives the
 *    recommendation and the shape, offers the detail elsewhere, and **the
 *    confidential body never reaches the TTS request. Assert on the outbound
 *    payload, not on what was heard.**"
 *
 * So the central assertion here is made against `ttsPayload()` — the thing that
 * leaves the box — and not against the rendering, and not against a flag saying
 * the rendering was the careful kind. A system that decides correctly and then
 * synthesises the document anyway passes every assertion made one step earlier.
 *
 * And equally:
 *
 *   "Ask for a normal one -> read and explained freely. **Both halves, or the
 *    rule is just switched off.**"
 *
 * A system that explains everything at metadata level satisfies every
 * confidentiality assertion in this file and is a worse assistant, so the normal
 * path is held to carrying the document.
 */
import {
  explainableFacts, forSpeaking, mayReadAloud, nothingFound, resolveWhen,
  transcriptClassification, ttsPayload, voiceRendering, type RecalledDocument,
} from "../src/voicerecall.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** Phrases that appear ONLY in the body, so finding one is proof it travelled. */
const SECRET_1 = "the Hensel contract penalty clause";
const SECRET_2 = "margin falls to eleven per cent in year two";

const CONFIDENTIAL: RecalledDocument = {
  artifactId: "a1", title: "Alpha migration", kind: "report",
  writtenAt: new Date("2026-09-03T09:00:00Z"),
  projects: ["confidential"],
  body: [
    "# Alpha migration report",
    "## Option two",
    `We should take option two. ${SECRET_1} makes option one unworkable,`,
    `and under option three ${SECRET_2}.`,
  ].join("\n"),
  recommendation: "option two, mostly on cost",
  optionCount: 3,
  tradeoffCount: 3,
};

const NORMAL: RecalledDocument = {
  ...CONFIDENTIAL,
  artifactId: "a2", title: "Scraper throughput", projects: ["normal"],
  body: "# Scraper throughput\n\n- The overnight run finished in **forty minutes**.\n- Nothing needs you.",
  recommendation: "leaving the schedule as it is",
};

/** "Anything spanning both takes the strictest classification present." */
const MIXED: RecalledDocument = { ...CONFIDENTIAL, artifactId: "a3", projects: ["normal", "confidential"] };

function main(): void {
  console.log("1. a confidential report, by voice");
  const r = voiceRendering(CONFIDENTIAL);
  r.mode === "explain" ? ok("it is explained, not read") : bad(`mode=${r.mode}`);
  /*
   * THE ASSERTION THE PLAN ASKS FOR, made against what leaves the box. Checking
   * the rendering, or a mode flag, would pass on a system that decided correctly
   * and synthesised the document anyway.
   */
  const outbound = ttsPayload(r);
  !outbound.text.includes(SECRET_1) && !outbound.text.includes(SECRET_2)
    ? ok("and the outbound TTS payload carries none of the body")
    : bad(`THE BODY REACHED THE SYNTHESISER: ${outbound.text}`);
  !outbound.text.includes("Option two\n") && !outbound.text.includes("# ")
    ? ok("nor its headings")
    : bad("the document's structure reached the synthesiser");
  /*
   * Not vacuous: an empty payload would satisfy every assertion above. The
   * sentence has to be USEFUL - "that sentence contains no confidential content
   * and is genuinely useful".
   */
  outbound.text.includes("Alpha migration") && outbound.text.includes("option two")
    ? ok(`while naming it and giving the recommendation: "${outbound.text}"`)
    : bad(`the explanation says too little: ${outbound.text}`);
  outbound.text.includes("three tradeoffs") || outbound.text.includes("three option")
    ? ok("and the shape of it")
    : bad("the shape was not offered");
  r.offer === "whatsapp"
    ? ok("with the detail offered on a channel that can carry it")
    : bad(`offer=${r.offer}`);

  console.log("");
  console.log("2. the other half, or the rule is just switched off");
  const n = voiceRendering(NORMAL);
  n.mode === "read" ? ok("a normal project's document is read") : bad(`mode=${n.mode}`);
  const normalOut = ttsPayload(n);
  normalOut.text.includes("forty minutes")
    ? ok("and its contents really do reach the synthesiser")
    : bad("a normal document was withheld too, which is the rule switched off");
  /*
   * Debug: "if the voice agent reads headings aloud, it is reciting rather than
   * explaining. The test is whether someone driving could follow it."
   */
  !normalOut.text.includes("#") && !normalOut.text.includes("**") && !normalOut.text.includes("- ")
    ? ok("rendered for the ear: no headings, no bullets, no asterisks")
    : bad(`recited rather than explained: ${normalOut.text}`);
  forSpeaking("# H\n\n- one\n- two\n\n| a | b |\n\nSee [the doc](https://x.test/y).")
    .match(/^H one two a b See the doc\.$/)
    ? ok("and the furniture of a written document comes out generally")
    : bad(`forSpeaking left furniture: ${JSON.stringify(forSpeaking("# H\n\n- one\n- two\n\n| a | b |\n\nSee [the doc](https://x.test/y)."))}`);

  console.log("");
  console.log("3. a document spanning both takes the stricter treatment");
  const m = voiceRendering(MIXED);
  m.mode === "explain" && !ttsPayload(m).text.includes(SECRET_1)
    ? ok("one normal project and one confidential is handled as confidential")
    : bad("a mixed document was read aloud");
  /*
   * The projection is the mechanism, so it is asserted directly: there is no
   * body field for a later edit to the phrasing to reach.
   */
  !Object.hasOwn(explainableFacts(CONFIDENTIAL), "body")
    ? ok("the facts a confidential rendering is built from have no body field at all")
    : bad("explainableFacts carries the document through");
  Object.keys(explainableFacts(CONFIDENTIAL)).sort().join(",")
    === "classification,kind,optionCount,recommendation,title,tradeoffCount,writtenAt"
    ? ok("and it names what it keeps, so a new field on the document stays put")
    : bad(`facts: ${Object.keys(explainableFacts(CONFIDENTIAL)).join(",")}`);

  console.log("");
  console.log("4. the transcript is a copy, and it outlives the call");
  /*
   * "A transcript inherits the strictest classification of anything discussed in
   * it." The same function S38 uses, not a second one that agrees today.
   */
  transcriptClassification(["normal", "confidential"]) === "confidential"
    ? ok("a call that touched confidential work produces a confidential transcript")
    : bad("the transcript did not inherit");
  transcriptClassification(["normal", "normal"]) === "normal"
    ? ok("while an ordinary call stays ordinary")
    : bad("every transcript was classified up, which is the rule switched off");
  transcriptClassification([]) === "restricted"
    ? ok("and a call whose subject nobody recorded is not read back on the strength of that absence")
    : bad("an unrecorded subject defaulted to normal");
  /*
   * "A later voice recall will not read IT aloud either" - one rule, not a
   * document rule plus a transcript exception.
   */
  !mayReadAloud(transcriptClassification(["confidential"])) && mayReadAloud("normal")
    ? ok("so a later recall will not synthesise that transcript either")
    : bad("the transcript rule and the document rule disagree");
  !mayReadAloud(null)
    ? ok("an unstamped artifact is not read aloud on the strength of a NULL")
    : bad("NULL was treated as normal");

  console.log("");
  console.log("5. relative time, and the day it means");
  const now = new Date("2026-09-05T21:30:00Z");
  const two = resolveWhen("two days ago", now);
  two && two.from.toISOString().startsWith("2026-09-03T00:00")
    ? ok("'two days ago' is that whole DAY, not that moment")
    : bad(`two days ago -> ${JSON.stringify(two)}`);
  /*
   * The bug a moment-based range hides: he asks in the evening for a document
   * written that morning, and an instant-anchored window excludes it.
   */
  two && CONFIDENTIAL.writtenAt >= two.from && CONFIDENTIAL.writtenAt < two.to
    ? ok("so a document written that morning is inside it when he asks at night")
    : bad("a morning document fell outside an evening query");
  resolveWhen("yesterday", now)?.from.toISOString().startsWith("2026-09-04")
    ? ok("yesterday resolves")
    : bad("yesterday did not resolve");
  resolveWhen("2 days ago", now)?.from.getTime() === two?.from.getTime()
    ? ok("digits and words agree")
    : bad("'2 days ago' and 'two days ago' differ");
  resolveWhen("last week", now) !== null ? ok("last week resolves") : bad("last week did not resolve");
  resolveWhen("the one about scraping", now) === null
    ? ok("while a phrase that is not a date is not forced into one")
    : bad("a content phrase was parsed as a date");

  console.log("");
  console.log("6. asking for something that is not there");
  const miss = nothingFound({ about: "the tax filing", when: "last week" });
  !miss.found && miss.say.includes("don't have anything")
    ? ok(`it says so: "${miss.say}"`)
    : bad("no clear answer for a miss");
  miss.found === false && miss.say.includes("not going to guess")
    ? ok("and says it will not improvise one, which is the failure mode")
    : bad("nothing prevents a plausible summary being invented");
  miss.say.includes("the tax filing")
    ? ok("naming what it looked for, so he can correct it")
    : bad("the miss does not say what was searched for");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
