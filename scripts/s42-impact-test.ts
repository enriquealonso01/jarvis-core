/**
 * S42 — approval by external impact, which revises IV.6.
 *
 * The governing question is no longer "what is this action" but "can anyone
 * other than Enrique see, receive, rely on, or be affected by it".
 *
 * The plan's Debug note names the failure this suite is mostly built to catch:
 *
 *   "If prompts feel frequent, look at what is being classified external. **The
 *    usual error is treating the tool as external rather than the action.**"
 *
 * So the central pair here is the same GitHub push on a solo private repository
 * and on one with collaborators. Any implementation keyed on the tool gives one
 * answer to both, and one of the two answers is always wrong.
 *
 * And the half the plan says can go wrong quietly:
 *
 *   "A month of recorded decisions narrows private-action prompts and leaves the
 *    external boundary exactly where it was. **Assert that second half.**"
 */
import {
  applyLearning, approvalFor, decideApproval, impactOf, LEARNING_THRESHOLD,
  type LearnedPreference,
} from "../src/impact.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const solo = { audience: [] };
const withCollaborators = { audience: ["two collaborators"] };

function main(): void {
  console.log("1. the same operation, on two repositories");
  /*
   * "The same service holds both. A private repository is internal; a change
   * collaborators or customers depend on is not." Asserted as a PAIR, because
   * either half alone is satisfied by a system that always gives that answer.
   */
  const onSolo = approvalFor({ action: "repo.push", reach: solo, origin: "instructed" });
  const onShared = approvalFor({ action: "repo.push", reach: withCollaborators, origin: "proposed" });
  onSolo.outcome === "proceed" && !onSolo.needsGrant
    ? ok("a push to his own solo repository proceeds, with no grant and no prompt")
    : bad(`solo push: ${JSON.stringify(onSolo)}`);
  onShared.outcome === "ask"
    ? ok("while the same operation where collaborators depend on it asks first")
    : bad(`shared push: ${JSON.stringify(onShared)}`);
  onShared.why.includes("two collaborators")
    ? ok(`and says who: "${onShared.why}"`)
    : bad("the prompt does not name who is affected");

  console.log("");
  console.log("2. private work is not gated at all");
  const privates: [string, string][] = [
    ["console.layout", "a private Control Center change"],
    ["desktop.prepare", "desktop preparation"],
    ["config.edit", "an internal config edit"],
  ];
  for (const [action, label] of privates) {
    const d = approvalFor({ action, reach: solo, origin: "proposed" });
    d.outcome === "proceed" && !d.needsGrant
      ? ok(`${label} proceeds with no prompt and no grant`)
      : bad(`${label}: ${JSON.stringify(d)}`);
  }
  /*
   * "It disappears by doing LESS, not by adding a mechanism." A grant issued for
   * a private action is a record of an authorisation nobody needed, and the
   * friction it adds is the friction this step removes.
   */
  approvalFor({ action: "console.layout", reach: solo, origin: "inferred" }).needsGrant === false
    ? ok("even when Jarvis thought of it itself — nobody else can see it either way")
    : bad("a private action Jarvis proposed still wanted a grant");

  console.log("");
  console.log("3. Jarvis does not ask twice");
  const email = { audience: ["the client"], leavesTheBox: true };
  const told = approvalFor({ action: "email.send", reach: email, origin: "instructed" });
  told.outcome === "proceed"
    ? ok("'send that email to the client' is sent, with no second confirmation")
    : bad(`an instructed external action asked anyway: ${told.why}`);
  /*
   * And the grant is still recorded. "The instruction authorises; the grant
   * records what it authorised, for which task, against which commit, until
   * when." Proceeding without one would make the authorisation unbounded, which
   * is the reading the plan explicitly rejects.
   */
  told.needsGrant
    ? ok("and it is still recorded as a grant, so the authorisation is bounded")
    : bad("an external action proceeded with nothing recording what authorised it");

  const proposed = approvalFor({ action: "email.send", reach: email, origin: "proposed" });
  proposed.outcome === "ask"
    ? ok("while Jarvis PROPOSING to email someone asks first")
    : bad("a proposed email was sent without asking");
  /*
   * "An action Enrique did not ask for does not inherit the authority of one he
   * did." Expanded is the interesting one: it is the same action he asked for,
   * grown.
   */
  approvalFor({ action: "email.send", reach: email, origin: "expanded" }).outcome === "ask"
    ? ok("and so does one that expanded beyond what he asked for")
    : bad("an expanded action inherited the authority of the instruction");
  approvalFor({ action: "email.send", reach: email, origin: "inferred" }).outcome === "ask"
    ? ok("and one Jarvis inferred")
    : bad("an inferred action proceeded");

  console.log("");
  console.log("4. the floor is untouched");
  /*
   * "This step could be misread as loosening it. IT DOES NOT." Level 3 is
   * checked BEFORE visibility, so no amount of reasoning about audience can
   * conclude that a production action on a solo project is private.
   */
  for (const action of ["repo.delete", "secrets.export", "spend.enable", "data.bulk_delete"]) {
    const d = approvalFor({ action, reach: solo, origin: "instructed" });
    d.outcome === "ask"
      ? ok(`${action} still always-confirms, even instructed and even with no audience`)
      : bad(`${action} slipped through as private: ${JSON.stringify(d)}`);
  }

  console.log("");
  console.log("5. what makes something external besides an audience");
  impactOf({ audience: [], reliedOn: true }).external
    ? ok("something outside the box relying on it is external with no audience named")
    : bad("reliedOn did not make it external");
  impactOf({ audience: [], leavesTheBox: true }).external
    ? ok("and so is anything that leaves the box at all")
    : bad("leavesTheBox did not make it external");
  !impactOf({ audience: ["enrique"] }).external
    ? ok("while an audience of only Enrique is not an audience")
    : bad("Enrique seeing his own work counted as external");
  !impactOf({ audience: [] }).external
    ? ok("and nothing at all is private")
    : bad("an empty reach was treated as external");

  console.log("");
  console.log("6. learning narrows prompts and never moves the boundary");
  const privatePref: LearnedPreference[] = [
    { scope: "private", action: "config.edit", approvals: LEARNING_THRESHOLD },
  ];
  /*
   * A private action that WOULD have prompted - here by being always-confirm is
   * wrong, so use one gated only by origin - stops prompting once he has
   * approved it enough times.
   */
  const before = decideApproval({
    action: "deploy.staging", reach: { audience: ["staging users"] }, origin: "proposed",
  });
  before.outcome === "ask" ? ok("an external proposal asks, before any learning") : bad("baseline wrong");

  /*
   * THE HALF THAT GOES WRONG QUIETLY. A preference is applied to an EXTERNAL
   * decision and must change nothing. The type cannot express an external
   * preference at all, so this hands it a private one for the same action and
   * checks the external decision is returned untouched.
   */
  const tempted = applyLearning(before, "deploy.staging", [
    { scope: "private", action: "deploy.staging", approvals: 99 },
  ]);
  tempted.outcome === "ask"
    ? ok("ninety-nine approvals do not teach it that an external action became internal")
    : bad("LEARNING MOVED THE EXTERNAL BOUNDARY");

  /*
   * And the other direction really does work, or "narrowing the prompts" is
   * switched off and only the safe half was built.
   */
  const privateAsk: ReturnType<typeof decideApproval> = {
    outcome: "ask", needsGrant: false, why: "a private action that used to prompt",
    impact: { external: false, who: [], why: "private" }, floor: false,
  };
  applyLearning(privateAsk, "config.edit", privatePref).outcome === "proceed"
    ? ok(`while ${LEARNING_THRESHOLD} approvals of a private action do stop the prompt`)
    : bad("learning never narrows anything, so only the safe half was built");
  applyLearning(privateAsk, "config.edit", [
    { scope: "private", action: "config.edit", approvals: LEARNING_THRESHOLD - 1 },
  ]).outcome === "ask"
    ? ok("and one approval short of the threshold does not")
    : bad("the threshold is not enforced");
  applyLearning(privateAsk, "something.else", privatePref).outcome === "ask"
    ? ok("and a preference about one action does not silence another")
    : bad("a learned preference leaked across actions");

  /*
   * Order: learning is applied inside approvalFor, after the floors. Applied
   * before them, a preference could suppress a Level 3 prompt.
   */
  approvalFor({
    action: "secrets.export", reach: solo, origin: "instructed",
    learned: [{ scope: "private", action: "secrets.export", approvals: 500 }],
  }).outcome === "ask"
    ? ok("and no number of approvals suppresses an always-confirm prompt")
    : bad("LEARNING SUPPRESSED A LEVEL 3 PROMPT");
  /*
   * The reason that one is not covered by the external check: an always-confirm
   * action can be entirely PRIVATE. Exporting secrets on a solo project has no
   * audience at all, so a guard that only asked "is this external" let a learned
   * preference through. Asserted directly so the fix cannot quietly regress into
   * the external check again.
   */
  decideApproval({ action: "secrets.export", reach: solo, origin: "instructed" }).impact.external === false
    ? ok("because an always-confirm action can be private, which is why the floor travels separately")
    : bad("the floor case is only being caught by the external check");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
