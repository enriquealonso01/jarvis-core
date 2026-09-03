/**
 * Adversarial probe of self-deployment (S54).
 *
 * This is the module that lets Jarvis replace its own control plane. The plan's
 * own framing: "a bad core deploy takes down the API, the runner, the broker and
 * the console, which is to say the very things that would notice, alert, and
 * roll back."
 */
import {
  HEALTH_CHECKS, healthVerdict, restorerSurvives, rollback, deployShapeFor,
  CONTROL_SURFACES, isControlSurface, needsResidualApproval, runnerUpdate, mayPromote,
  type HealthCheck, type CheckResult, type SupervisorLocation,
} from "../src/selfdeploy.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
};
const allPass = Object.fromEntries(HEALTH_CHECKS.map((c) => [c, "pass"])) as Record<HealthCheck, CheckResult>;

console.log("\n== a check that cannot run is not a pass ==");
ok("everything green is healthy", healthVerdict(allPass).healthy === true);
ok("one explicit fail is unhealthy", healthVerdict({ ...allPass, queue_dispatches: "fail" }).healthy === false);
ok("one unknown is unhealthy", healthVerdict({ ...allPass, broker_decrypts_canary: "unknown" }).healthy === false);
ok("a MISSING result is unhealthy", (() => {
  const partial = { ...allPass }; delete (partial as any).runner_claims;
  const v = healthVerdict(partial);
  return v.healthy === false && v.unknown.includes("runner_claims");
})());
ok("no results at all is unhealthy", healthVerdict({}).healthy === false);
ok("and it says which could not be run", /counts as failure/.test(healthVerdict({}).why));
ok("a bogus result value is not a pass",
  healthVerdict({ ...allPass, api_answers: "PASS" as CheckResult }).healthy === false);
ok("all six checks are considered", healthVerdict({}).unknown.length === HEALTH_CHECKS.length);

console.log("\n== the restorer does not live inside what it restores ==");
ok("a host unit survives", restorerSurvives("host_unit").survives === true);
ok("an external watchdog survives", restorerSurvives("external_watchdog").survives === true);
ok("inside compose does not", restorerSurvives("inside_compose").survives === false);
ok("inside the api does not", restorerSurvives("inside_api").survives === false);
for (const junk of ["constructor", "__proto__", "HOST_UNIT", ""]) {
  ok(`${JSON.stringify(junk)} does not count as surviving`,
    restorerSurvives(junk as SupervisorLocation).survives === false);
}

console.log("\n== a rollback never restores the database ==");
ok("the database is untouched", rollback("v41").database === "untouched");
ok("and there is no value that includes it",
  !JSON.stringify(rollback("v41")).toLowerCase().includes("restore_database"));

console.log("\n== the migration shape ==");
ok("backward compatible ships ordinarily",
  deployShapeFor({ backwardCompatible: true } as any).shape === "ordinary");
const notReady = deployShapeFor({ backwardCompatible: false } as any) as any;
ok("not backward compatible ships alone", notReady.shape === "its_own_deploy");
ok("and is not ready without a written rollback", notReady.ready === false);
ok("ready needs BOTH rollback and restore point",
  (deployShapeFor({ backwardCompatible: false, rollbackWritten: true } as any) as any).ready === false);
ok("with both, it is ready",
  (deployShapeFor({ backwardCompatible: false, rollbackWritten: true, verifiedRestorePoint: true } as any) as any).ready === true);
console.log("  -- a flag that is not a boolean --");
ok('backwardCompatible "false" is not backward compatible',
  deployShapeFor({ backwardCompatible: "false" } as any).shape === "its_own_deploy",
  JSON.stringify(deployShapeFor({ backwardCompatible: "false" } as any)));

console.log("\n== the residual approval is matched on surfaces ==");
for (const s of CONTROL_SURFACES) {
  ok(`${s} needs approval`, needsResidualApproval([s]).needsApproval === true);
}
ok("something ordinary does not", needsResidualApproval(["docs", "ui"]).needsApproval === false);
ok("one control surface among many still stops it",
  needsResidualApproval(["docs", "spend", "ui"]).needsApproval === true);
for (const junk of ["constructor", "__proto__", "AUTH", "auth "]) {
  ok(`${JSON.stringify(junk)} is not a control surface`, !isControlSurface(junk));
}

console.log("\n== the runner is not updated by a task it is running ==");
ok("a running task may not", runnerUpdate({ runnerBusy: false, requestedBy: "running_task" }).apply === false);
ok("the system worker may, when idle",
  runnerUpdate({ runnerBusy: false, requestedBy: "system_worker" }).apply === true);
ok("not while busy", runnerUpdate({ runnerBusy: true, requestedBy: "system_worker" }).apply === false);
console.log("  -- a requester that is neither --");
for (const junk of ["constructor", "__proto__", "", "SYSTEM_WORKER", "anything"]) {
  const u = runnerUpdate({ runnerBusy: false, requestedBy: junk as any });
  ok(`${JSON.stringify(junk)} may not update the runner`, u.apply === false, JSON.stringify(u));
}

console.log("\n== the whole gate ==");
const green = {
  acceptanceSuitePassed: true, evalSuitePassed: true,
  migration: { backwardCompatible: true }, touches: [] as string[],
};
ok("green, compatible, touching nothing -> promote", mayPromote(green as any).promote === true);
ok("a failed acceptance suite stops at canary",
  (mayPromote({ ...green, acceptanceSuitePassed: false } as any) as any).stage === "canary");
ok("a failed eval suite stops at canary",
  (mayPromote({ ...green, evalSuitePassed: false } as any) as any).stage === "canary");
ok("an incompatible migration stops at migration",
  (mayPromote({ ...green, migration: { backwardCompatible: false } } as any) as any).stage === "migration");
ok("even a READY incompatible migration does not auto-promote",
  mayPromote({ ...green, migration: { backwardCompatible: false, rollbackWritten: true, verifiedRestorePoint: true } } as any).promote === false);
ok("a control surface stops at approval",
  (mayPromote({ ...green, touches: ["kill_switch"] } as any) as any).stage === "approval");
ok("a broken change is reported as broken, not as awaiting approval",
  (mayPromote({ ...green, acceptanceSuitePassed: false, touches: ["auth"] } as any) as any).stage === "canary");
console.log("  -- gate inputs that are not booleans --");
for (const bad of ["false", "no", "0", "off"]) {
  ok(`acceptanceSuitePassed ${JSON.stringify(bad)} does not promote`,
    mayPromote({ ...green, acceptanceSuitePassed: bad } as any).promote === false,
    JSON.stringify(mayPromote({ ...green, acceptanceSuitePassed: bad } as any)));
}
ok("a missing acceptance result does not promote",
  mayPromote({ ...green, acceptanceSuitePassed: undefined } as any).promote === false);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
