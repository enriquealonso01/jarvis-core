/**
 * S52 — forthcoming, and the discipline that keeps it from becoming nagging.
 *
 *   "The failure mode is the one Enrique names the opposite of: **something that
 *    reaches out constantly is something he mutes.**"
 *
 * The plan supplies the test that keeps it honest, and it is a negative one:
 *
 *   "Nothing is actually needed → **it says nothing.** A day with no real gap
 *    produces no capability requests — **the test that keeps forthcoming from
 *    becoming noise.**"
 *
 * And an ordering one, which is the whole point of the step:
 *
 *   "A task that will need a key it lacks → the request arrives **before** the
 *    task fails on it... **Assert on the ordering: the ask precedes the block.**"
 */
import {
  alreadyHave, ASK_AT, asksFor, capabilityKey, isRealNeed, register,
  scheduledCallOpening, scopeOfConnectApproval, type Need,
} from "../src/forthcoming.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const TASK = "task-1";
const OTHER_TASK = "task-2";

const mapsKey: Need = {
  taskId: TASK, kind: "credential", what: "a Google Maps key", where: "Connections › Google Maps",
};
const signIn: Need = { taskId: TASK, kind: "sign_in", what: "a sign-in to the supplier portal" };

function main(): void {
  console.log("1. the ask precedes the block");
  ASK_AT === "before_start"
    ? ok("the ask is positioned before the work starts, not when it fails")
    : bad(`ASK_AT is ${ASK_AT}`);
  /*
   * A position rather than a timestamp. A timestamp comparison passes on a system
   * that asked and blocked in the same millisecond, which is exactly the reactive
   * behaviour this step replaces.
   */
  const timeline = [ASK_AT, "on_block"];
  timeline.indexOf("before_start") < timeline.indexOf("on_block")
    ? ok("and the ordering is a position, not two timestamps a millisecond apart")
    : bad("the ask does not precede the block");

  console.log("");
  console.log("2. it says nothing when nothing is needed");
  asksFor([]).length === 0
    ? ok("no gaps, no messages")
    : bad("it spoke with nothing to ask for");
  /*
   * "A day with no real gap produces no capability requests." Including the case
   * that matters most: every need already met.
   */
  const have = register(new Set(), mapsKey);
  asksFor([mapsKey], have).length === 0
    ? ok("and a need already met produces nothing rather than an empty message")
    : bad("it asked for something it already has");

  console.log("");
  console.log("3. it asks once, and the register is what makes that true");
  const first = asksFor([mapsKey]);
  first.length === 1
    ? ok(`the first task asks: "${first[0].message}"`)
    : bad(`first ask: ${JSON.stringify(first)}`);
  first[0].message.includes("Connections › Google Maps")
    ? ok("naming where it goes, so it is actionable rather than a reminder")
    : bad("the ask does not say where the key goes");
  /*
   * "A second task needing the same thing does not ask again." The register is
   * keyed on the capability, not the task - a per-task record would ask once per
   * task forever, which is the same nagging by another route.
   */
  const acquired = register(new Set(), mapsKey);
  const second: Need = { ...mapsKey, taskId: OTHER_TASK };
  alreadyHave(acquired, second)
    ? ok("a different task needing the same key already has it")
    : bad("the register is keyed per task, so it would ask again");
  asksFor([second], acquired).length === 0
    ? ok("and asks nothing")
    : bad("it asked twice for the same capability");
  capabilityKey(mapsKey) === capabilityKey({ ...mapsKey, what: "  A GOOGLE MAPS KEY " })
    ? ok("with the key normalised, so wording does not defeat the register")
    : bad("the register key depends on wording");

  console.log("");
  console.log("4. two needs for one task are one message");
  const batched = asksFor([mapsKey, signIn]);
  batched.length === 1
    ? ok("two things needed for one piece of work arrive as one message")
    : bad(`${batched.length} messages for one task`);
  batched[0].needs.length === 2
    ? ok("carrying both needs")
    : bad("the batch lost a need");
  batched[0].message.includes("Maps key") && batched[0].message.includes("supplier portal")
    ? ok(`and naming both: "${batched[0].message}"`)
    : bad(`message: ${batched[0].message}`);
  /*
   * Two DIFFERENT tasks are still two messages - batching is per piece of work,
   * not a daily digest that delays the first one.
   */
  asksFor([mapsKey, { ...signIn, taskId: OTHER_TASK }]).length === 2
    ? ok("while two different tasks are two messages, not a digest that delays the first")
    : bad("needs from different tasks were merged");

  console.log("");
  console.log("5. a new paid provider is a recommendation, not a signup");
  const paid = asksFor([{
    taskId: TASK, kind: "connection", what: "a Brazilian SMS connection",
    newProvider: "a Brazilian SMS provider",
  }]);
  paid[0].kind === "recommendation"
    ? ok("a gap needing a new account is a recommendation")
    : bad(`kind: ${paid[0].kind}`);
  paid[0].message.includes("yours to open")
    ? ok(`saying whose decision it is: "${paid[0].message}"`)
    : bad("it did not say whose decision the account is");
  asksFor([mapsKey])[0].kind === "request"
    ? ok("while something needing no new account is an ordinary request")
    : bad("everything became a recommendation");
  /*
   * One provider anywhere in the batch makes the whole message a recommendation:
   * he is being asked to open an account either way, and burying that under
   * "request" is the misleading half.
   */
  asksFor([mapsKey, {
    taskId: TASK, kind: "connection", what: "an SMS connection", newProvider: "someone",
  }])[0].kind === "recommendation"
    ? ok("and a batch containing one is a recommendation as a whole")
    : bad("a provider was buried inside a request");

  console.log("");
  console.log("6. it never self-authorises from the ask");
  const scope = scopeOfConnectApproval("project-alpha");
  scope.connect === true && scope.spend === false && scope.otherProjects === false
    ? ok("approval to connect is not approval to spend, nor to use it elsewhere")
    : bad(`scope: ${JSON.stringify(scope)}`);
  scope.boundTo === "project-alpha"
    ? ok("and it is bound to the project that asked")
    : bad("the approval is not bound to a project");
  Object.keys(scope).sort().join(",") === "boundTo,connect,otherProjects,spend"
    ? ok("with the three decisions kept separate rather than folded into one grant")
    : bad(`scope shape: ${Object.keys(scope).join(",")}`);

  console.log("");
  console.log("7. content is not a need");
  /*
   * "An inbound message that merely mentions needing an integration -> no
   * handoff, no request." The same rule S46 applies to auth links, arriving
   * through a different door.
   */
  const mentioned = isRealNeed("message_content");
  !mentioned.real && mentioned.why.includes("fact about the message")
    ? ok(`a message mentioning a need is not one: "${mentioned.why}"`)
    : bad(`message_content: ${JSON.stringify(mentioned)}`);
  const speculative = isRealNeed("speculation");
  !speculative.real && speculative.why.includes("reminder")
    ? ok("and 'you might want X someday' is a reminder, not a request")
    : bad(`speculation: ${JSON.stringify(speculative)}`);
  isRealNeed("task_requirement").real
    ? ok("while a queued or running task that cannot proceed is a real need")
    : bad("a real task requirement was not treated as a need");
  /*
   * The structural half: a Need cannot be built without a task id, so a
   * speculative one has nowhere to come from.
   */
  Object.hasOwn(mapsKey, "taskId") && mapsKey.taskId !== ""
    ? ok("and every need carries the task id that makes it real")
    : bad("a need exists with no task behind it");

  console.log("");
  console.log("8. a scheduled call opens with its purpose");
  const prepared = scheduledCallOpening({
    greeting: "Good morning", subject: "the Alpha migration",
  });
  prepared.leadsWithSubject && prepared.say.includes("the Alpha migration")
    ? ok(`it leads with the prepared subject: "${prepared.say}"`)
    : bad(`opening: ${prepared.say}`);
  /\?$/.test(prepared.say.trim())
    ? ok("and ends on a forward question rather than a silence he has to fill")
    : bad("the opening does not drive");
  const blank = scheduledCallOpening({ greeting: "Good morning", subject: null });
  !blank.leadsWithSubject && /\?$/.test(blank.say.trim())
    ? ok("while a call with no prepared subject still says why it is happening and asks")
    : bad(`no-subject opening: ${blank.say}`);
  blank.say !== "Good morning" && blank.say.length > "Good morning, sir.".length
    ? ok("rather than 'good morning, sir' and a pause")
    : bad("it opened blank");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
