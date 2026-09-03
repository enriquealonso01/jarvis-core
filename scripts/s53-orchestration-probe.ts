/**
 * Adversarial probe of many-agent orchestration (S53).
 *
 * The plan's own words: "the most powerful step in the engineering half, and
 * the easiest to turn into a runaway... Ungoverned, it is an unbounded fan-out
 * of leases and spend that starves every other project and bills without
 * limit." Four numeric guards stand between that sentence and the bill, so all
 * four are given values a number column can actually hold.
 */
import {
  isDone, shouldContinue, MAX_ITERATIONS, admitAgent, PER_ORCHESTRATION_CEILING,
  SYSTEM_CEILING, isRealProgress, REAL_PROGRESS, IDLE_ROUNDS_ALLOWED, watchdogVerdict,
  spendCheck, killOrchestration, mayShipCore, mayReadProject, worktreeFor,
  type Agent, type DoneCondition,
} from "../src/orchestration.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
};
const NOT_DONE: DoneCondition = { coversTheGoal: false, openGaps: 2, passesItsChecklist: false };
const DONE: DoneCondition = { coversTheGoal: true, openGaps: 0, passesItsChecklist: true };
const NONSENSE = [NaN, undefined, null, "" as any, "3" as any, -1, Infinity];

console.log("\n== the done condition is three facts, not a score ==");
ok("all three -> done", isDone(DONE));
ok("a gap left open is not done", !isDone({ ...DONE, openGaps: 1 }));
ok("not covering the goal is not done", !isDone({ ...DONE, coversTheGoal: false }));
ok("failing its checklist is not done", !isDone({ ...DONE, passesItsChecklist: false }));
ok('openGaps "0" as a string is not zero gaps', !isDone({ ...DONE, openGaps: "0" as any }));

console.log("\n== the loop backstop ==");
ok("an unfinished plan goes round again", shouldContinue(NOT_DONE, 0).continue === true);
ok("a finished one stops", shouldContinue(DONE, 0).continue === false);
ok(`${MAX_ITERATIONS} rounds is the ceiling`, shouldContinue(NOT_DONE, MAX_ITERATIONS).continue === false);
ok("and it says the planner is at fault, not the goal",
  /something is wrong with the planner/.test((shouldContinue(NOT_DONE, MAX_ITERATIONS) as any).why));
ok("shouldContinue has no clock in scope", shouldContinue.length === 2);
console.log("  -- an iteration count that is not a count --");
for (const bad of NONSENSE) {
  const d = shouldContinue(NOT_DONE, bad as number);
  const safe = d.continue === false || Number.isInteger((d as any).iteration);
  ok(`iterationsSoFar=${JSON.stringify(bad) ?? "undefined"} cannot loop forever`, safe, JSON.stringify(d));
}

console.log("\n== the fan-out ceiling ==");
ok("under both ceilings, admit",
  admitAgent({ agentsInThisOrchestration: 1, agentsSystemWide: 1 }).admit === true);
ok("at the orchestration ceiling, queue",
  admitAgent({ agentsInThisOrchestration: PER_ORCHESTRATION_CEILING, agentsSystemWide: 0 }).admit === false);
ok("at the system ceiling, queue",
  admitAgent({ agentsInThisOrchestration: 0, agentsSystemWide: SYSTEM_CEILING }).admit === false);
ok("queued rather than refused",
  (admitAgent({ agentsInThisOrchestration: PER_ORCHESTRATION_CEILING, agentsSystemWide: 0 }) as any).queue === true);
console.log("  -- agent counts that are not counts --");
for (const bad of NONSENSE) {
  ok(`agentsInThisOrchestration=${JSON.stringify(bad) ?? "undefined"} does not admit`,
    admitAgent({ agentsInThisOrchestration: bad as number, agentsSystemWide: 0 }).admit === false,
    JSON.stringify(admitAgent({ agentsInThisOrchestration: bad as number, agentsSystemWide: 0 })));
  ok(`agentsSystemWide=${JSON.stringify(bad) ?? "undefined"} does not admit`,
    admitAgent({ agentsInThisOrchestration: 0, agentsSystemWide: bad as number }).admit === false);
}

console.log("\n== the watchdog ==");
for (const m of REAL_PROGRESS) ok(`${m} is real progress`, isRealProgress(m));
for (const junk of ["constructor", "__proto__", "", "CHECKPOINT", "thinking"]) {
  ok(`${JSON.stringify(junk)} is not progress`, !isRealProgress(junk));
}
ok("real progress keeps it alive",
  watchdogVerdict({ markers: ["checkpoint"], roundsWithoutProgress: 99 }).stop === false);
ok("idle past the allowance stops it",
  watchdogVerdict({ markers: [], roundsWithoutProgress: IDLE_ROUNDS_ALLOWED }).stop === true);
ok("a fabricated marker is not progress",
  watchdogVerdict({ markers: ["thinking"], roundsWithoutProgress: IDLE_ROUNDS_ALLOWED }).stop === true);
console.log("  -- idle rounds that are not a count --");
for (const bad of NONSENSE) {
  ok(`roundsWithoutProgress=${JSON.stringify(bad) ?? "undefined"} still stops an idle loop`,
    watchdogVerdict({ markers: [], roundsWithoutProgress: bad as number }).stop === true,
    JSON.stringify(watchdogVerdict({ markers: [], roundsWithoutProgress: bad as number })));
}

console.log("\n== the money ==");
ok("under the ceiling, proceed", spendCheck(100, 1000).proceed === true);
ok("at the ceiling, pause", spendCheck(1000, 1000).proceed === false);
ok("over the ceiling, pause", spendCheck(1001, 1000).proceed === false);
ok("and it says it did not go past", /have not gone past it/.test((spendCheck(1000, 1000) as any).say));
console.log("  -- a spend figure or ceiling that is not a number --");
for (const bad of NONSENSE) {
  ok(`spent=${JSON.stringify(bad) ?? "undefined"} does not proceed`,
    spendCheck(bad as number, 1000).proceed === false, JSON.stringify(spendCheck(bad as number, 1000)));
  ok(`ceiling=${JSON.stringify(bad) ?? "undefined"} does not proceed`,
    spendCheck(100, bad as number).proceed === false, JSON.stringify(spendCheck(100, bad as number)));
}

console.log("\n== more hands, not more authority ==");
ok("no agent ships core", mayShipCore().allowed === false);
const a: Agent = { id: "a1", role: "builder", orchestrationId: "o1", projectId: "p1" };
ok("an agent reads its own project", mayReadProject(a, "p1") === true);
ok("and not another", mayReadProject(a, "p2") === false);
ok("and not the system scope", mayReadProject(a, null) === false);
const killed = killOrchestration([a, { ...a, id: "a2" }, { ...a, id: "a3" }]);
ok("one action stops every agent", killed.stopped.length === 3 && killed.leasesReleased === 3);
ok("killing none is still coherent", killOrchestration([]).leasesReleased === 0);
ok("each agent gets its own worktree",
  worktreeFor(a).path !== worktreeFor({ ...a, id: "a2" }).path);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
