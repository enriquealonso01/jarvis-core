/**
 * S38 — a long answer is a document, and how it travels is a security decision.
 *
 *   "**A confidential project's report arrives as a link, and the content is not
 *    in the message.** Then a normal project's arrives as an attachment. **Both
 *    halves** — a rule that only ever links has not been tested, it has been
 *    disabled."
 *
 *   "A report spanning a normal and a confidential project → treated as
 *    confidential."
 *
 *   "A short answer stays a short answer — the rule must not turn 'yes' into a
 *    PDF."
 *
 * The both-halves clause is why every confidentiality assertion here has its
 * opposite beside it. A policy that links everything satisfies "confidential
 * work is linked" perfectly and has simply stopped doing the useful thing.
 */
import {
  coveringNote, decideDelivery, linkIsSafe, LONG_MESSAGE_CHARS, strictestOf,
  type Confidentiality,
} from "../src/brevity.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const long = LONG_MESSAGE_CHARS + 500;
const shape = (chars: number, projects: Confidentiality[], decisionPacket = false) =>
  ({ chars, projects, decisionPacket });

function main(): void {
  console.log("1. a short answer stays a short answer");
  const yes = decideDelivery(shape(3, ["normal"]));
  yes.delivery === "inline"
    ? ok(`"yes" is three characters and stays a message: ${yes.why}`)
    : bad(`a three-character answer became a ${yes.delivery}`);
  /*
   * And short from a CONFIDENTIAL project is still short. Rendering it as a
   * document would put the same words on Meta's infrastructure with extra
   * steps, so the length rule is not a confidentiality rule wearing a hat.
   */
  decideDelivery(shape(20, ["confidential"])).delivery === "inline"
    ? ok("and a short answer from a confidential project is still a message")
    : bad("a twenty-character confidential answer became a document");

  console.log("");
  console.log("2. a long one becomes a document");
  decideDelivery(shape(long, ["normal"])).delivery !== "inline"
    ? ok(`${long} characters is a document, not a wall of text`)
    : bad("a long answer was sent as a message");
  /*
   * A decision packet is a document at any length, because what makes it one is
   * that a decision is taken FROM it - not that it is big.
   */
  const packet = decideDelivery(shape(120, ["normal"], true));
  packet.delivery === "attach"
    ? ok("and a decision packet is a document even at 120 characters")
    : bad(`a short decision packet was sent as ${packet.delivery}`);

  console.log("");
  console.log("3. both halves of the confidentiality rule");
  const normal = decideDelivery(shape(long, ["normal"]));
  normal.delivery === "attach"
    ? ok(`a normal project's report is ATTACHED: ${normal.why}`)
    : bad(`a normal report was ${normal.delivery} — the rule has been disabled, not implemented`);
  const conf = decideDelivery(shape(long, ["confidential"]));
  conf.delivery === "link"
    ? ok(`a confidential project's report is LINKED: ${conf.why}`)
    : bad(`a confidential report was ${conf.delivery}`);
  decideDelivery(shape(long, ["restricted"])).delivery === "link"
    ? ok("and restricted work is linked too")
    : bad("a restricted report was attached");
  normal.delivery !== conf.delivery
    ? ok("the two differ, so this is a rule rather than a constant")
    : bad("normal and confidential are delivered identically");

  console.log("");
  console.log("4. a mixed document is a confidential document");
  const mixed = decideDelivery(shape(long, ["normal", "confidential"]));
  mixed.classification === "confidential" && mixed.delivery === "link"
    ? ok("a report spanning a normal and a confidential project is linked")
    : bad(`a mixed report was ${mixed.delivery} as ${mixed.classification}`);
  strictestOf(["normal", "restricted", "confidential"]) === "restricted"
    ? ok("and the strictest class present wins, not the commonest")
    : bad(`the strictest of normal/restricted/confidential came out as ${strictestOf(["normal", "restricted", "confidential"])}`);
  /*
   * The empty case, which is the one a default would get wrong quietly: a
   * document whose projects nobody could determine is not a document to attach
   * on that basis.
   */
  strictestOf([]) === "restricted"
    ? ok("a document of unknown provenance is treated as restricted, not as normal")
    : bad("an unclassifiable document defaulted to normal and would be attached");

  console.log("");
  console.log("5. the covering note is two lines, and the second is the decision");
  const note = coveringNote({
    what: "Supplier comparison: three options, Meridian recommended.",
    decision: "Approve Meridian, or tell me which to look at again.",
    delivery: "attach",
  });
  note.split("\n").length === 2
    ? ok(`two lines: "${note.replace("\\n", " / ")}"`)
    : bad(`the covering note is ${note.split("\n").length} lines`);
  const linked = coveringNote({
    what: "Q3 review.", decision: "Sign off or send back.",
    delivery: "link", url: "https://jarvis.example.com/artifacts/abc",
  });
  linked.includes("https://jarvis.example.com/artifacts/abc")
    ? ok("and a linked one carries the URL on the decision line")
    : bad("the link is missing from the covering note");

  console.log("");
  console.log("6. a link is only worth sending if it needs a session");
  linkIsSafe("https://jarvis.example.com/artifacts/abc").safe
    ? ok("a plain https artifact URL is fine")
    : bad("a good link was rejected");
  /*
   * The convenience that undoes the whole rule: a one-time token so it opens
   * without signing in. A URL travels exactly the way an attachment does, and
   * only the session keeps the content on the box - so a tokenised link IS the
   * attachment it was meant to replace.
   */
  const tokened = linkIsSafe("https://jarvis.example.com/artifacts/abc?t=deadbeefcafe");
  !tokened.safe && tokened.why.includes("without a session")
    ? ok(`a link carrying a token is refused: "${tokened.why}"`)
    : bad("a tokenised link was treated as safe");
  !linkIsSafe("https://jarvis.example.com/a?signature=xyz").safe
    ? ok("and so is a signed one, by any of its usual names")
    : bad("a signed URL passed");
  !linkIsSafe("http://jarvis.example.com/artifacts/abc").safe
    ? ok("plain http is refused")
    : bad("an http link was accepted for a confidential document");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
