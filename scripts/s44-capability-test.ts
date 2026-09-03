/**
 * S44 — "I don't have that tool" is not an acceptable answer.
 *
 * The plan gives one test in imperative form, so it is the one this suite is
 * shaped around:
 *
 *   "**Nothing it builds requires a core deploy to use. Assert this directly.**
 *    The capability works without `jarvis-core` being rebuilt. **If it does not,
 *    the step built a change to Jarvis while calling it a tool.**"
 *
 * And the failure it guards against, in the plan's own words: "a request that
 * genuinely needs a core change → **it says so and proposes**, rather than
 * finding a plugin-shaped way to express it." So the interesting assertion is
 * not that a core change is rejected — it is that a caller who WANTS a
 * plugin-shaped answer cannot get one. The suite asks for a schema change while
 * insisting the shape is an MCP server, which is exactly how that mistake would
 * arrive.
 *
 * Second, from the Debug note: "if it starts building for every gap, the cost
 * estimate is missing. **Building a tool is sometimes the wrong answer and the
 * estimate is what makes that visible.**"
 */
import {
  ATTACHABLE_FORMS, CORE_REQUIREMENTS, EXPENSIVE_DAYS, formFor, mayCall,
  needsCoreDeploy, proposeCapability,
} from "../src/capability.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const PROJECT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function main(): void {
  console.log("1. something out of reach becomes a proposal, not a refusal");
  const p = proposeCapability({
    need: "send messages on Signal", requirements: ["an mcp server", "a phone number"],
    shape: "mcp_server", estimateDays: 2, projectId: PROJECT,
  });
  p.verdict === "attachable" && p.form === "mcp_server"
    ? ok(`it proposes a shape and a cost: "${p.say}"`)
    : bad(`verdict=${p.verdict}`);
  "estimateDays" in p && p.estimateDays === 2
    ? ok("with the estimate attached, not implied")
    : bad("no estimate on the proposal");
  !/cannot|can't do|don't have that tool/i.test(p.say)
    ? ok("and it does not refuse")
    : bad(`it refused: ${p.say}`);
  /*
   * These sentences are what he reads. "a mcp server" is what a first-letter
   * vowel test produces and it is wrong for the same reason "a hour" is - the
   * article follows the sound, and MCP is said em-see-pee.
   */
  p.say.includes("an MCP server") && !new RegExp("\\ba mcp\\b", "i").test(p.say)
    ? ok("and it reads like a sentence rather than a template")
    : bad(`the article is wrong: ${p.say}`);

  console.log("");
  console.log("2. the estimate is what makes 'don't build this' visible");
  const noEstimate = proposeCapability({
    need: "generate images", requirements: ["an adapter"], shape: "adapter", projectId: PROJECT,
  });
  noEstimate.verdict === "no_estimate"
    ? ok(`without one there is no proposal at all: "${noEstimate.say}"`)
    : bad("a capability was proposed with no idea what it costs");
  /*
   * "'I could build that but it would take a week and here is the cheaper
   * alternative' is the right answer far more often than either extreme."
   */
  const expensive = proposeCapability({
    need: "build a full CRM", requirements: ["an adapter"], shape: "adapter",
    estimateDays: 10, alternative: "a shared spreadsheet with two columns", projectId: PROJECT,
  });
  expensive.verdict === "attachable" && expensive.say.includes("spreadsheet")
    ? ok(`an expensive one carries the cheaper option: "${expensive.say}"`)
    : bad(`no alternative offered: ${expensive.say}`);
  EXPENSIVE_DAYS > 0 && expensive.say.includes("week")
    ? ok("and says how long in words he can act on")
    : bad("the estimate is not legible");
  const cheap = proposeCapability({
    need: "read a CSV", requirements: ["a script"], shape: "script",
    estimateDays: 0.5, projectId: PROJECT,
  });
  cheap.verdict === "attachable" && !cheap.say.includes("would be quicker")
    ? ok("while a half-day job is not padded with alternatives nobody needs")
    : bad("a cheap job was talked out of");

  console.log("");
  console.log("3. nothing it builds requires a core deploy");
  for (const form of ATTACHABLE_FORMS) {
    !needsCoreDeploy(form)
      ? ok(`${form} is loaded at runtime — no core rebuild`)
      : bad(`${form} would need core rebuilt, so it is not a tool`);
  }
  needsCoreDeploy("core_change")
    ? ok("and only a core change does, which is what makes it not a tool")
    : bad("a core change was treated as attachable");

  console.log("");
  console.log("4. a plugin-shaped way to express a core change is not available");
  /*
   * THE ASSERTION THIS SUITE EXISTS FOR. The caller asks for a schema change and
   * INSISTS the shape is an MCP server, which is exactly how "finding a
   * plugin-shaped way to express it" arrives. The form is derived from the
   * requirements, so the insistence has nowhere to land.
   */
  const disguised = proposeCapability({
    need: "track supplier contracts", requirements: ["schema_change", "an mcp server"],
    shape: "mcp_server", estimateDays: 4, projectId: PROJECT,
  });
  disguised.verdict === "core_change"
    ? ok("asking for a schema change while calling it an MCP server still comes back a core change")
    : bad(`IT FOUND A PLUGIN-SHAPED WAY: ${JSON.stringify(disguised)}`);
  disguised.verdict === "core_change" && disguised.because.includes("schema_change")
    ? ok(`and names which requirement decided it: ${disguised.because.join(", ")}`)
    : bad("the reason is not checkable");
  disguised.say.includes("isn't a tool")
    ? ok(`saying so plainly: "${disguised.say}"`)
    : bad(`it did not say so plainly: ${disguised.say}`);
  formFor(["schema_change"], "mcp_server") === "core_change"
    ? ok("the form is read off the requirements, never off the shape the caller wanted")
    : bad("a caller-supplied shape overrode the requirements");
  /*
   * Named here rather than iterated from CORE_REQUIREMENTS. The first version
   * looped over the exported list, which derives the test's expectations from
   * the thing under test: deleting an entry deleted the assertion with it, and
   * shrinking the list to just the schema change passed. Sabotage found that.
   * The plan names schema changes, new lanes and broker changes explicitly; the
   * rest are the same kind of thing and are listed because forgetting one is
   * the failure.
   */
  const MUST_BE_CORE = [
    "schema_change", "migration", "new_lane",
    "broker_change", "new_queue_state", "safety_surface",
  ];
  const escapable = MUST_BE_CORE.filter((r) => formFor([r], "adapter") !== "core_change");
  escapable.length === 0
    ? ok(`all ${MUST_BE_CORE.length} of them do this, not just the schema one`)
    : bad(`can be expressed as a plugin: ${escapable.join(", ")}`);
  MUST_BE_CORE.every((r) => (CORE_REQUIREMENTS as readonly string[]).includes(r))
    ? ok("and none has been quietly dropped from the exported list")
    : bad(`missing from CORE_REQUIREMENTS: ${MUST_BE_CORE.filter((r) => !(CORE_REQUIREMENTS as readonly string[]).includes(r)).join(", ")}`);

  console.log("");
  console.log("5. a new paid provider is a recommendation, never a signup");
  const paid = proposeCapability({
    need: "send SMS in Brazil", requirements: ["a connection"], shape: "connection",
    estimateDays: 1, newProvider: "a Brazilian SMS provider", projectId: PROJECT,
  });
  paid.verdict === "needs_provider"
    ? ok(`it recommends rather than signing up: "${paid.say}"`)
    : bad(`verdict=${paid.verdict}`);
  paid.say.includes("your call")
    ? ok("and says whose decision it is")
    : bad("it did not say whose decision the account is");
  /*
   * Checked BEFORE the form: a signup is a signup whether the code that follows
   * is a plugin or a core change.
   */
  proposeCapability({
    need: "x", requirements: ["schema_change"], estimateDays: 1,
    newProvider: "someone", projectId: PROJECT,
  }).verdict === "needs_provider"
    ? ok("even when the work behind it would also be a core change")
    : bad("a signup was buried under a core-change verdict");

  console.log("");
  console.log("6. what it built is not trusted for being homegrown");
  const manifest = "sha256:abc";
  const classified = {
    form: "mcp_server" as const, level: 2, classifiedHash: manifest, manifestHash: manifest,
    builtForProject: PROJECT, callingFromProject: PROJECT,
  };
  mayCall(classified).allowed
    ? ok("a classified, unchanged tool called from its own project works")
    : bad("a properly classified tool was refused");
  !mayCall({ ...classified, level: null }).allowed
    ? ok("but not before a person has given it a blast radius")
    : bad("AN UNCLASSIFIED HOMEGROWN TOOL WAS CALLABLE");
  mayCall({ ...classified, level: null }).why.includes("stranger")
    ? ok("and the reason says why: it gets the scrutiny a stranger's would")
    : bad("the reason does not hold the rule");
  !mayCall({ ...classified, manifestHash: "sha256:changed" }).allowed
    ? ok("nor after it changed under its own classification")
    : bad("a changed tool kept its classification");
  !mayCall({ ...classified, callingFromProject: OTHER }).allowed
    ? ok("and it is denied from a project it was not built for")
    : bad("A CAPABILITY CROSSED A PROJECT BOUNDARY");
  !mayCall({ ...classified, form: "core_change" }).allowed
    ? ok("while a core change is not callable as a tool at all")
    : bad("a core change was callable");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
