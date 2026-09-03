/**
 * S53 — many agents on one goal, and the three governors.
 *
 * The plan's Debug note names each failure and where it lives, so each is
 * asserted at that place rather than at its symptom:
 *
 *   "If it spawns without bound, **the ceiling is being checked per agent instead
 *    of per orchestration** — the fan-out point is where the limit belongs."
 *
 *   "If loops never stop, **the done-condition is a timer rather than a state
 *    check** — a loop with no real stop is a bill with a heartbeat."
 *
 *   "If agents collide, they are **sharing a tree or a state object** without the
 *    single-writer discipline."
 *
 * The headline assertion is the plan's own: "**assert the planner stops on the
 * condition, not after a fixed time** — a loop that runs forever is the failure
 * this step exists to prevent." So the loop is driven to its condition with the
 * clock held still, which is only meaningful because there is no clock in scope
 * to move.
 */
import {
  admitAgent, IDLE_ROUNDS_ALLOWED, isDone, isRealProgress, killOrchestration,
  MAX_ITERATIONS, mayReadProject, mayShipCore, PER_ORCHESTRATION_CEILING,
  REAL_PROGRESS, shouldContinue, spendCheck, SYSTEM_CEILING, watchdogVerdict,
  worktreeFor, type Agent, type DoneCondition,
} from "../src/orchestration.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const ORCH = "orch-1";
const ALPHA = "alpha";
const agent = (id: string, role: Agent["role"]): Agent =>
  ({ id, role, orchestrationId: ORCH, projectId: ALPHA });

const notSolid: DoneCondition = { coversTheGoal: true, openGaps: 2, passesItsChecklist: false };
const solid: DoneCondition = { coversTheGoal: true, openGaps: 0, passesItsChecklist: true };

function main(): void {
  console.log("1. the planner stops on the condition, not on a clock");
  /*
   * Driven to the condition with time held still. That is only meaningful
   * because there is no clock in scope to move - asserted structurally below.
   */
  let iterations = 0;
  let decision = shouldContinue(notSolid, iterations);
  while (decision.continue && iterations < 50) {
    iterations = decision.iteration;
    /* The gaps close on the third round. Nothing about elapsed time changes. */
    decision = shouldContinue(iterations >= 3 ? solid : notSolid, iterations);
  }
  !decision.continue && decision.reason === "done" && iterations === 3
    ? ok(`the loop ran ${iterations} rounds and stopped because the plan became solid`)
    : bad(`loop ended: ${JSON.stringify(decision)} after ${iterations}`);
  /*
   * THE STRUCTURAL HALF, as in S49 and S51: a driven loop proves this run. This
   * proves the function has nothing to stop on but the condition.
   */
  !/Date|now\(|elapsed|deadline|timer|setTimeout|interval/i.test(shouldContinue.toString())
    ? ok("and shouldContinue has no clock, deadline or timer in scope at all")
    : bad("the loop can be ended by time passing, which is a timer wearing a condition");
  isDone(solid) && !isDone(notSolid)
    ? ok("'solid' is three checkable fields, not a score with a threshold to turn down")
    : bad("the done condition is not checkable");
  !isDone({ coversTheGoal: true, openGaps: 0, passesItsChecklist: false })
    ? ok("and all three must hold — two out of three is not solid")
    : bad("a partial condition counted as done");

  console.log("");
  console.log("2. and it cannot loop forever even if the condition never comes");
  /*
   * A planner whose condition is never satisfied because it is broken bills
   * exactly like one with no condition at all.
   */
  const stuck = shouldContinue(notSolid, MAX_ITERATIONS);
  !stuck.continue && stuck.reason === "ceiling"
    ? ok(`a condition that never arrives still stops at ${MAX_ITERATIONS}: "${stuck.why}"`)
    : bad(`no backstop: ${JSON.stringify(stuck)}`);
  stuck.why.includes("wrong with the planner")
    ? ok("and says the planner is the problem, not the goal")
    : bad("the ceiling stop does not say what went wrong");

  console.log("");
  console.log("3. the ceiling is checked where the fan-out happens");
  /*
   * "The ceiling is being checked per agent instead of per orchestration" is the
   * named failure, so the input is a COUNT rather than an agent - an agent asked
   * whether it may run always answers yes, because it is only one.
   */
  admitAgent({ agentsInThisOrchestration: 0, agentsSystemWide: 0 }).admit
    ? ok("the first agent starts")
    : bad("nothing may start");
  const atOrch = admitAgent({
    agentsInThisOrchestration: PER_ORCHESTRATION_CEILING, agentsSystemWide: 0,
  });
  !atOrch.admit && atOrch.queue
    ? ok(`at ${PER_ORCHESTRATION_CEILING} agents the next one QUEUES rather than spawning`)
    : bad(`orchestration ceiling: ${JSON.stringify(atOrch)}`);
  const atSystem = admitAgent({ agentsInThisOrchestration: 1, agentsSystemWide: SYSTEM_CEILING });
  !atSystem.admit && atSystem.why.includes("other projects")
    ? ok("and a system-wide ceiling protects the other projects' lanes")
    : bad(`system ceiling: ${JSON.stringify(atSystem)}`);
  /*
   * Queued, not refused: a refused agent is work he asked for that silently never
   * happens.
   */
  atOrch.admit === false && atOrch.queue === true
    ? ok("over the ceiling means waiting, not being dropped")
    : bad("an agent over the ceiling was refused rather than queued");

  console.log("");
  console.log("4. a tree each, and a branch each");
  const one = worktreeFor(agent("a1", "builder"));
  const two = worktreeFor(agent("a2", "builder"));
  one.path !== two.path && one.branch !== two.branch
    ? ok("two builders on one goal get two worktrees and two branches")
    : bad(`shared tree: ${one.path} / ${two.path}`);
  one.path.includes(ORCH) && one.path.includes("a1")
    ? ok("derived from the agent, so a caller cannot hand two agents the same path")
    : bad(`worktree path: ${one.path}`);
  one.branch.startsWith(`orchestration/${ORCH}/`)
    ? ok(`and the branch names the orchestration it belongs to: ${one.branch}`)
    : bad(`branch: ${one.branch}`);

  console.log("");
  console.log("5. 'it ran again' is not progress");
  const ranAgain = watchdogVerdict({ markers: ["ran_again", "ran_again"], roundsWithoutProgress: IDLE_ROUNDS_ALLOWED });
  ranAgain.stop
    ? ok(`running again three times is stopped: "${ranAgain.why}"`)
    : bad("a looping agent with nothing to show was left running");
  !isRealProgress("ran_again") && !isRealProgress("thinking") && !isRealProgress("started")
    ? ok("because running again is not on the list of things that count")
    : bad("'ran again' counts as progress");
  REAL_PROGRESS.every((m) => isRealProgress(m)) && REAL_PROGRESS.length === 4
    ? ok(`while ${REAL_PROGRESS.join(", ")} all do`)
    : bad("the progress list is wrong");
  const working = watchdogVerdict({ markers: ["ran_again", "gap_closed"], roundsWithoutProgress: 9 });
  !working.stop
    ? ok("and an agent that closed a gap is left alone, however many rounds it took")
    : bad("a productive agent was stopped");

  console.log("");
  console.log("6. spend pauses, it does not blow through");
  const under = spendCheck(400, 1000);
  under.proceed === true && under.remaining === 600
    ? ok("under the ceiling it carries on, and says how much is left")
    : bad(`under: ${JSON.stringify(under)}`);
  const at = spendCheck(1000, 1000);
  !at.proceed && at.paused
    ? ok(`at the ceiling it pauses: "${at.say}"`)
    : bad(`at ceiling: ${JSON.stringify(at)}`);
  !at.proceed && at.say.includes("have not gone past it")
    ? ok("saying it stopped at the line rather than after crossing it")
    : bad("the pause does not say where it stopped");
  /*
   * Paused rather than killed - the work is not wrong, it reached a limit, and
   * killing it would lose what it has done.
   */
  !at.proceed && !/stopped all|killed/i.test(at.say)
    ? ok("and paused rather than killed, so what it has done is not lost")
    : bad("hitting the spend ceiling destroyed the work");

  console.log("");
  console.log("7. one action stops everything");
  const swarm = [agent("a1", "planner"), agent("a2", "builder"), agent("a3", "builder"),
    agent("a4", "reviewer")];
  const killed = killOrchestration(swarm);
  killed.stopped.length === swarm.length && killed.leasesReleased === swarm.length
    ? ok(`one action stops all ${swarm.length} agents and releases every lease`)
    : bad(`kill: ${JSON.stringify(killed)}`);
  /*
   * It takes the orchestration's agents rather than a list somebody assembles -
   * assembling that list is where one gets missed.
   */
  killed.stopped.join(",") === "a1,a2,a3,a4"
    ? ok("with none of them left behind")
    : bad(`stopped: ${killed.stopped.join(",")}`);

  console.log("");
  console.log("8. more hands, not more authority");
  const ship = mayShipCore();
  ship.allowed === false && ship.why.includes("more hands, not more authority")
    ? ok(`no agent in a swarm ships core: "${ship.why}"`)
    : bad(`mayShipCore: ${JSON.stringify(ship)}`);
  /*
   * "Isolation holds across EVERY agent, not just the first" - which is why the
   * check takes the agent.
   */
  swarm.every((a) => mayReadProject(a, ALPHA))
    ? ok("every agent can read the project it belongs to")
    : bad("an agent was denied its own project");
  swarm.every((a) => !mayReadProject(a, "beta"))
    ? ok("and not one of them can read another, however many there are")
    : bad("AN AGENT IN THE SWARM CROSSED A PROJECT BOUNDARY");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
