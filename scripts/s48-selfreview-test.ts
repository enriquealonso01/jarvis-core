/**
 * S48 — the single deliberate exception to isolation, and its shape.
 *
 *   "**S48 is the single deliberate exception** — it reads every conversation from
 *    every surface and every project... **An exception that broad, arriving in the
 *    last step, is how isolation quietly stops meaning anything. So it needs a
 *    shape.**"
 *
 * The plan's own test says exactly where to look:
 *
 *   "Two projects, one confidential, both carrying the same repeated correction →
 *    found once and ranked, **and the confidential project's conversation body
 *    appears nowhere in the merge input or the report. Assert on what crossed
 *    between passes, not on what the report says about itself.**"
 *
 * So the confidential transcripts here contain a phrase that exists nowhere else,
 * and the suite hunts for that phrase in everything that leaves the pass — the
 * findings, the merge output, the report, and the JSON of all three. A system that
 * merges correctly and carries one helpful excerpt passes every other assertion in
 * this file and fails those.
 *
 * And the Debug note's trap, which is the other half:
 *
 *   "If cross-project repetition stops being detected once the passes are split,
 *    the finding shape is carrying prose instead of a normalised correction. **Two
 *    passes describing the same defect in different words will never match.**"
 *
 * So the two projects' corrections are worded DIFFERENTLY on purpose, and still
 * have to merge into one ranked finding.
 */
import {
  actionFor, correctionFingerprint, describeWeek, mergeFindings, projectPass,
  reportClassification, routeForPass, type Finding, type Transcript,
} from "../src/selfreview.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** Appears only inside the confidential project's transcripts. */
const SECRET = "the Hensel penalty clause";
const ALPHA = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";

const alphaTranscripts: Transcript[] = [{
  conversationId: "c-alpha-1", projectId: ALPHA,
  turns: [{ n: 4, text: `No — stop calling me Enrique. Also ${SECRET} is why option one is out.` }],
}];
const betaTranscripts: Transcript[] = [{
  conversationId: "c-beta-1", projectId: BETA,
  turns: [{ n: 2, text: "Use my first name only, please." }],
}];

function main(): void {
  console.log("1. each pass sees one project, and only its own");
  const alpha = projectPass({
    projectId: ALPHA, classification: "confidential", transcripts: alphaTranscripts,
    corrections: [
      /* Worded one way here... */
      { behaviour: "form_of_address", correctedTo: "Enri", conversationId: "c-alpha-1", turn: 4 },
      { behaviour: "form_of_address", correctedTo: "Enri", conversationId: "c-alpha-1", turn: 9 },
    ],
  });
  const beta = projectPass({
    projectId: BETA, classification: "normal", transcripts: betaTranscripts,
    /* ...and differently there. The normalisation is what makes them match. */
    corrections: [{ behaviour: "form_of_address", correctedTo: "  ENRI ", conversationId: "c-beta-1", turn: 2 }],
  });
  alpha.length === 1 && alpha[0].occurrences === 2
    ? ok("Alpha's pass folds its two corrections into one finding")
    : bad(`alpha: ${JSON.stringify(alpha)}`);
  /*
   * A pass handed another project's transcript has already made the mistake this
   * step is shaped around, so it refuses rather than filtering.
   */
  let refused = false;
  try {
    projectPass({
      projectId: BETA, classification: "normal",
      transcripts: [...betaTranscripts, ...alphaTranscripts], corrections: [],
    });
  } catch { refused = true; }
  refused
    ? ok("and a pass handed another project's transcript refuses rather than quietly dropping it")
    : bad("A PASS ACCEPTED TWO PROJECTS' TRANSCRIPTS");

  console.log("");
  console.log("2. what crossed between passes");
  const merged = mergeFindings([alpha, beta]);
  /*
   * THE ASSERTION THE PLAN ASKS FOR, made on the merge INPUT and OUTPUT rather
   * than on the report's own description of itself.
   */
  const crossed = JSON.stringify([alpha, beta]);
  !crossed.includes(SECRET)
    ? ok("no confidential body is in what the passes handed over")
    : bad("THE CONFIDENTIAL BODY CROSSED BETWEEN PASSES");
  !JSON.stringify(merged).includes(SECRET)
    ? ok("nor in the merge output")
    : bad("THE CONFIDENTIAL BODY IS IN THE MERGE OUTPUT");
  !describeWeek(merged).includes(SECRET)
    ? ok("nor in the report")
    : bad("THE CONFIDENTIAL BODY IS IN THE REPORT");
  /*
   * Not vacuous: the phrase really is in the transcripts the pass read, so its
   * absence downstream is a fact about the projection rather than about the
   * fixture.
   */
  JSON.stringify(alphaTranscripts).includes(SECRET)
    ? ok("while the phrase genuinely was in the transcripts Alpha's pass read")
    : bad("the fixture never contained the secret, so the assertions above prove nothing");
  const fields = Object.keys(alpha[0]).sort().join(",");
  !/quote|excerpt|body|sample|text/.test(fields)
    ? ok(`and a finding has no field that could hold one: ${fields}`)
    : bad(`a finding carries content: ${fields}`);

  console.log("");
  console.log("3. a citation cites, it does not quote");
  const citation = alpha[0].citations[0];
  Object.keys(citation).sort().join(",") === "conversationId,turn"
    ? ok("a citation is a conversation and a turn, and nothing else")
    : bad(`citation: ${JSON.stringify(citation)}`);
  citation.conversationId === "c-alpha-1" && citation.turn === 4
    ? ok("resolving in the console, where he can already see everything")
    : bad("the citation does not point anywhere useful");

  console.log("");
  console.log("4. the same defect in different words is one finding");
  /*
   * "Two passes describing the same defect in different words will never match"
   * — unless the correction is normalised. Alpha said "Enri", Beta said "  ENRI ".
   */
  merged.length === 1
    ? ok("one merged finding, not two unrelated one-offs")
    : bad(`${merged.length} findings: ${JSON.stringify(merged.map((m) => m.correctedTo))}`);
  merged[0].projects === 2 && merged[0].occurrences === 3
    ? ok(`ranked by reach: ${merged[0].projects} projects, ${merged[0].occurrences} occurrences`)
    : bad(`merged: ${JSON.stringify(merged[0])}`);
  correctionFingerprint("form_of_address", "Enri") === correctionFingerprint("form_of_address", " enri ")
    ? ok("because the fingerprint is over a normalised correction, not a sentence")
    : bad("the fingerprint depends on wording");
  correctionFingerprint("form_of_address", "Enri") !== correctionFingerprint("message_length", "Enri")
    ? ok("while a different behaviour is a different finding")
    : bad("two behaviours share a fingerprint");

  console.log("");
  console.log("5. repeated corrections rank above everything else");
  const oneProjectThrice: Finding[] = [{
    behaviour: "weak_answer", correctedTo: "cite the source", projectId: ALPHA,
    classification: "normal", citations: [{ conversationId: "c", turn: 1 }],
    occurrences: 9, alreadyFixed: false,
  }];
  const ranked = mergeFindings([alpha, beta, oneProjectThrice]);
  ranked[0].projects === 2
    ? ok("a correction in two projects outranks one appearing nine times in one")
    : bad(`ranking put ${ranked[0].behaviour} first`);

  console.log("");
  console.log("6. already-fixed issues are dropped silently");
  const fixedPass = projectPass({
    projectId: BETA, classification: "normal", transcripts: betaTranscripts,
    corrections: [{ behaviour: "message_length", correctedTo: "short", conversationId: "c-beta-1", turn: 5 }],
    fixedBehaviours: ["message_length"],
  });
  fixedPass[0].alreadyFixed
    ? ok("the pass knows it was fixed, because it can see the current behaviour")
    : bad("the pass did not mark it fixed");
  mergeFindings([fixedPass]).length === 0
    ? ok("and it does not reach the report at all")
    : bad("a fixed issue was re-raised");
  describeWeek(mergeFindings([fixedPass])) === "Nothing worth changing this week."
    ? ok("a week with nothing left says so, briefly")
    : bad(`empty week: ${describeWeek(mergeFindings([fixedPass]))}`);
  /*
   * "A cycle that always finds problems is a cycle that invents them, and this
   * test is what keeps it honest."
   */
  describeWeek([]).length < 60
    ? ok("in one short sentence rather than a reassuring summary of nothing")
    : bad("the empty report is long");

  console.log("");
  console.log("7. the report takes the strictest classification it touched");
  reportClassification(["normal", "confidential"]) === "confidential"
    ? ok("a report spanning a confidential project is confidential")
    : bad("the report did not inherit");
  reportClassification(["normal", "normal"]) === "normal"
    ? ok("while one spanning only normal projects stays normal")
    : bad("every report was classified up, which is the rule switched off");
  merged[0].classification === "confidential"
    ? ok("and a merged finding raised by a confidential project carries that too")
    : bad(`merged classification: ${merged[0].classification}`);

  console.log("");
  console.log("8. a pass fails closed rather than downgrading");
  /*
   * "A fallback that silently picks another provider is the whole defect wearing
   * a retry." There is no fallback parameter to pass.
   */
  const stuck = routeForPass({
    classification: "confidential", permitted: ["anthropic-subscription"], available: ["free-consumer-api"],
  });
  "refused" in stuck && stuck.why.includes("does not run")
    ? ok(`with no permitted provider up, the pass does not run: "${stuck.why}"`)
    : bad(`it routed anyway: ${JSON.stringify(stuck)}`);
  const fine = routeForPass({
    classification: "confidential", permitted: ["anthropic-subscription"],
    available: ["anthropic-subscription", "free-consumer-api"],
  });
  "provider" in fine && fine.provider === "anthropic-subscription"
    ? ok("and runs on the permitted one when it is up, rather than never running")
    : bad(`route: ${JSON.stringify(fine)}`);

  console.log("");
  console.log("9. it produces work, not observations");
  const action = actionFor(merged[0]);
  action?.action === "preference" && action.key === "comm.address_as"
    ? ok(`a form-of-address correction becomes a preference change: ${JSON.stringify(action)}`)
    : bad(`action: ${JSON.stringify(action)}`);
  actionFor({
    behaviour: "missing_capability", correctedTo: "sending Signal messages", fingerprint: "x",
    projects: 1, occurrences: 2, citations: [], classification: "normal",
  })?.action === "task"
    ? ok("a missing capability becomes a task, which is what feeds S44")
    : bad("a missing capability produced no work");
  /*
   * "An issue that cannot be turned into a task or a preference change is not
   * carried; it is either actionable or it is dropped."
   */
  actionFor({
    behaviour: "weak_answer", correctedTo: "be better", fingerprint: "y",
    projects: 1, occurrences: 1, citations: [], classification: "normal",
  }) === null
    ? ok("while an observation nobody can act on is dropped rather than printed")
    : bad("an unactionable observation was carried");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
