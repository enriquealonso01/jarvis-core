/**
 * Adversarial probe of the weekly self-review (S48).
 *
 * The file calls itself "the single deliberate exception to isolation in the
 * whole plan". The claim under test is its own: "merge findings, never
 * transcripts" - and specifically that Finding "has no field for a body, a
 * quote or an excerpt".
 */
import {
  projectPass, mergeFindings, describeWeek, reportClassification,
  correctionFingerprint, isBehaviour, BEHAVIOURS, isNormalisedTarget,
  type Finding, type Transcript,
} from "../src/selfreview.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const tr = (projectId: string | null, conversationId: string): Transcript =>
  ({ conversationId, projectId, turns: [{ n: 1, text: "a body that must not travel" }] });

console.log("\n== a pass refuses another project's transcript ==");
try {
  projectPass({
    projectId: A, classification: "normal",
    transcripts: [tr(A, "c1"), tr(B, "c2")], corrections: [],
  });
  ok("refuses a foreign transcript", false, "it accepted one");
} catch { ok("refuses a foreign transcript", true); }
ok("accepts its own", projectPass({
  projectId: A, classification: "normal", transcripts: [tr(A, "c1")], corrections: [],
}).length === 0);
try {
  projectPass({ projectId: null, classification: "normal", transcripts: [tr(A, "c1")], corrections: [] });
  ok("system scope refuses a project transcript", false, "it accepted one");
} catch { ok("system scope refuses a project transcript", true); }

console.log("\n== the closed vocabulary is actually closed ==");
for (const b of BEHAVIOURS) ok(`${b} is a behaviour`, isBehaviour(b));
for (const junk of ["constructor", "__proto__", "toString", "", "WRONG_PROJECT"]) {
  ok(`${JSON.stringify(junk)} is not`, !isBehaviour(junk));
}
ok("an unknown behaviour produces no finding", projectPass({
  projectId: A, classification: "normal", transcripts: [],
  corrections: [{ behaviour: "constructor", correctedTo: "x", conversationId: "c", turn: 1 }],
}).length === 0);

console.log("\n== what actually crosses between passes ==");
// The leak channel: correctedTo is a free string, and the analyser fills it
// from the transcript it just read. The type has no `quote` field - but this
// is a body-shaped hole with a comment on it.
const SECRET = "he said the ticketflipping RDS password is hunter2 and to stop asking about it";
const leaky = projectPass({
  projectId: A, classification: "confidential", transcripts: [tr(A, "c1")],
  corrections: [{ behaviour: "form_of_address", correctedTo: SECRET, conversationId: "c1", turn: 4 }],
});
const other = projectPass({
  projectId: B, classification: "normal", transcripts: [tr(B, "c2")],
  corrections: [{ behaviour: "message_length", correctedTo: "shorter", conversationId: "c2", turn: 2 }],
});
const merged = mergeFindings([leaky, other]);
const report = describeWeek(merged);
const crossed = JSON.stringify(merged).toLowerCase().includes("hunter2");
ok("project A's prose does not reach the merged findings", !crossed,
  `correctedTo = ${JSON.stringify(merged.find((m) => m.behaviour === "form_of_address")?.correctedTo)}`);
ok("project A's prose does not reach the report", !report.toLowerCase().includes("hunter2"), report);

console.log("\n== citations carry a reference, not content ==");
const withCites = projectPass({
  projectId: A, classification: "normal", transcripts: [tr(A, "c1")],
  corrections: [
    { behaviour: "channel_choice", correctedTo: "whatsapp", conversationId: "c1", turn: 3 },
    { behaviour: "channel_choice", correctedTo: "whatsapp", conversationId: "c1", turn: 9 },
  ],
});
ok("two of the same correction merge, occurrences counted", withCites[0].occurrences === 2);
ok("both turns cited", withCites[0].citations.length === 2);
ok("a citation has only a conversation and a turn",
  Object.keys(withCites[0].citations[0]).sort().join(",") === "conversationId,turn");
ok("no body field on a finding",
  !("body" in withCites[0]) && !("quote" in withCites[0]) && !("excerpt" in withCites[0]));

console.log("\n== fingerprints match across differently-worded passes ==");
ok("same behaviour + target -> same fingerprint",
  correctionFingerprint("form_of_address", "First Name") === correctionFingerprint("form_of_address", "first name"));
ok("whitespace normalised",
  correctionFingerprint("form_of_address", " first   name ") === correctionFingerprint("form_of_address", "first name"));
ok("different behaviour -> different fingerprint",
  correctionFingerprint("form_of_address", "first name") !== correctionFingerprint("message_length", "first name"));

console.log("\n== ranking and classification ==");
const f = (behaviour: any, correctedTo: string, projectId: string | null, occurrences: number,
  classification: any = "normal"): Finding =>
  ({ behaviour, correctedTo, projectId, classification, citations: [], occurrences, alreadyFixed: false });
const ranked = mergeFindings([
  [f("message_length", "shorter", A, 3)],
  [f("channel_choice", "whatsapp", A, 1)],
  [f("channel_choice", "whatsapp", B, 1)],
]);
ok("a correction in two projects outranks one seen three times in one",
  ranked[0].behaviour === "channel_choice" && ranked[0].projects === 2, JSON.stringify(ranked.map((r) => r.behaviour)));
ok("strictest classification wins across projects",
  mergeFindings([[f("weak_answer", "x", A, 1, "normal")], [f("weak_answer", "x", B, 1, "confidential")]])[0]
    .classification === "confidential");
ok("already-fixed is dropped silently",
  mergeFindings([[{ ...f("weak_answer", "x", A, 1), alreadyFixed: true }]]).length === 0);
ok("report classification is the strictest touched",
  reportClassification(["normal", "confidential", "normal"]) === "confidential");
ok("an empty week says so", describeWeek([]) === "Nothing worth changing this week.");

console.log("");
console.log("== a normalised target, and the sentences that are not one ==");
for (const good of ["first name", "whatsapp", "shorter", "under 200 words", "ask first",
  "the console", "e.g. 200 words", "don't", "spain/madrid"]) {
  ok(`accepts ${JSON.stringify(good)}`, isNormalisedTarget(good));
}
for (const bad of [
  "he said the ticketflipping rds password is hunter2 and to stop asking about it",
  "https://evil.com/leak",
  "mail@ticketflipping.com",
  "",
  "   ",
  "a".repeat(49),
  "call the client back about the thing we discussed on tuesday",
]) {
  ok(`rejects ${JSON.stringify(bad.slice(0, 34))}`, !isNormalisedTarget(bad));
}
ok("48 chars is still a target", isNormalisedTarget("a".repeat(48)));
ok("a legitimate correction still produces a finding", projectPass({
  projectId: A, classification: "normal", transcripts: [],
  corrections: [{ behaviour: "form_of_address", correctedTo: "First  Name", conversationId: "c", turn: 1 }],
})[0].correctedTo === "first name");

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
