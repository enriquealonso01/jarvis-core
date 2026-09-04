/**
 * S54 — deploying its own control plane, and the four ways of not trusting it.
 *
 * The plan names the pair that is the test:
 *
 *   "A change touching **auth / isolation / backups / spend or the kill switch**
 *    → ships through the pipeline **but stops for the residual approval**, even
 *    with every automated check green. A change to the queue's batch size does
 *    not. **That pair is the test** — one without the other proves the carve-out
 *    is stuck in one position."
 *
 * And the Debug note says how the classifier goes wrong: "if the residual approval
 * never fires, **the classifier is matching on file paths instead of on what the
 * change touches** — the auth surface is reachable by more than one path." So the
 * suite passes a change that touches auth *through isolation* and requires it to
 * stop anyway.
 *
 * The other assertion that carries this step is VII.5's inversion: **a check that
 * cannot run counts as failure.** An exception handler that swallows a failed
 * probe reports health, and the deploy that broke the queue is exactly the deploy
 * whose queue probe throws.
 */
import {
  CONTROL_SURFACES, deployShapeFor, HEALTH_CHECKS, healthVerdict, mayPromote,
  needsResidualApproval, restorerSurvives, rollback, runnerUpdate,
  type HealthCheck, type CheckResult,
} from "../src/selfdeploy.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const allPass = Object.fromEntries(
  HEALTH_CHECKS.map((c) => [c, "pass" as CheckResult]),
) as Record<HealthCheck, CheckResult>;

function main(): void {
  console.log("1. a check that cannot run counts as failure");
  healthVerdict(allPass).healthy
    ? ok(`all ${HEALTH_CHECKS.length} checks passing is healthy`)
    : bad("a fully green release was called unhealthy");
  /*
   * THE INVERSION. An exception handler that swallows a failed probe reports
   * health, and the deploy that broke the queue is exactly the deploy whose queue
   * probe throws.
   */
  const cannotRun = healthVerdict({ ...allPass, queue_dispatches: "unknown" });
  !cannotRun.healthy && cannotRun.unknown.includes("queue_dispatches")
    ? ok(`a probe that could not run is unhealthy: "${cannotRun.why}"`)
    : bad(`unknown was treated as healthy: ${JSON.stringify(cannotRun)}`);
  /*
   * And absence is not a pass either - a results object missing a key is the
   * same situation as an explicit unknown, and is the more likely one.
   */
  const missing = healthVerdict({ api_answers: "pass" });
  !missing.healthy && missing.unknown.length === HEALTH_CHECKS.length - 1
    ? ok("and a check that was never reported at all is unknown, not absent-therefore-fine")
    : bad(`missing checks: ${JSON.stringify(missing)}`);
  /*
   * The naive check the plan calls out: a change that passes 200-OK and fails the
   * real one.
   */
  const naive = healthVerdict({ ...allPass, queue_dispatches: "fail" });
  !naive.healthy && naive.failed.includes("queue_dispatches")
    ? ok("a release whose API answers but whose queue does not dispatch is unhealthy")
    : bad("a 200-OK release passed while the queue was dead");

  console.log("");
  console.log("2. the restorer does not live inside what it restores");
  restorerSurvives("host_unit").survives && restorerSurvives("external_watchdog").survives
    ? ok("a host unit or an external watchdog is still there when the new core never comes up")
    : bad("the out-of-band restorers were rejected");
  const inside = restorerSurvives("inside_compose");
  !inside.survives && inside.why.includes("except the one that matters")
    ? ok(`a restorer inside the stack is refused: "${inside.why}"`)
    : bad(`inside_compose: ${JSON.stringify(inside)}`);
  !restorerSurvives("inside_api").survives
    ? ok("and so is one wired through the API the deploy just replaced")
    : bad("a rollback path through the API was accepted");

  console.log("");
  console.log("3. a rollback never restores the database");
  const back = rollback("core-2026-09-11a");
  back.restored === "previous_release" && back.database === "untouched"
    ? ok(`it restores the image and nothing else: "${back.say}"`)
    : bad(`rollback: ${JSON.stringify(back)}`);
  /*
   * Asserted on the SHAPE as well, because the flag somebody adds during an
   * incident is the thing that would break this, and a value check would still
   * pass on the day it was added but not set.
   */
  Object.keys(back).sort().join(",") === "database,restored,say"
    ? ok("with no field through which a database restore could be asked for")
    : bad(`rollback shape: ${Object.keys(back).join(",")}`);

  console.log("");
  console.log("4. expand-contract, or the rollback makes things worse");
  const compatible = deployShapeFor({ backwardCompatible: true });
  compatible.shape === "ordinary"
    ? ok("a backward-compatible migration ships as an ordinary deploy")
    : bad(`compatible: ${JSON.stringify(compatible)}`);
  const bare = deployShapeFor({ backwardCompatible: false });
  bare.shape === "its_own_deploy" && !bare.ready
    ? ok(`one that is not is refused as ordinary: "${bare.why}"`)
    : bad(`non-compatible: ${JSON.stringify(bare)}`);
  bare.shape === "its_own_deploy" && bare.why.includes("automated way to make things worse")
    ? ok("and says why, which is that a rollback would leave the old image on a schema it cannot read")
    : bad("the refusal does not say why");
  const prepared = deployShapeFor({
    backwardCompatible: false, rollbackWritten: true, verifiedRestorePoint: true,
  });
  prepared.shape === "its_own_deploy" && prepared.ready
    ? ok("while one with its rollback written and a verified restore point may ship alone")
    : bad("a properly prepared migration was still refused");
  /*
   * `.ready` off an un-narrowed union is `undefined`, and `!undefined` is true —
   * so this assertion passed no matter what deployShapeFor did. The typechecker
   * found it the moment scripts came under it. Narrowed, it is an assertion.
   */
  const noRestorePoint = deployShapeFor({ backwardCompatible: false, rollbackWritten: true });
  noRestorePoint.shape === "its_own_deploy" && !noRestorePoint.ready
    ? ok("and a written rollback without a verified restore point is not enough")
    : bad(`a restore point was optional: ${JSON.stringify(noRestorePoint)}`);

  console.log("");
  console.log("5. the pair that is the test");
  /*
   * "One without the other proves the carve-out is stuck in one position", so
   * both directions, with everything else green.
   */
  const green = { acceptanceSuitePassed: true, evalSuitePassed: true, migration: { backwardCompatible: true } };
  const batchSize = mayPromote({ ...green, touches: ["queue_batch_size"] });
  batchSize.promote
    ? ok("a change to the queue's batch size promotes with no human step")
    : bad(`batch size was gated: ${batchSize.why}`);
  const auth = mayPromote({ ...green, touches: ["auth"] });
  !auth.promote && auth.stage === "approval"
    ? ok(`while a change touching auth stops for approval with every check green: "${auth.why}"`)
    : bad(`auth change: ${JSON.stringify(auth)}`);
  /*
   * THE DEBUG NOTE'S FAILURE. The auth surface is reachable by more than one
   * path, so the classifier is given what the change TOUCHES and there is no path
   * parameter for it to match on.
   */
  const viaIsolation = needsResidualApproval(["isolation"]);
  viaIsolation.needsApproval
    ? ok("a change reaching auth through isolation stops too — the surface, not the file")
    : bad("the classifier missed a control surface reached by another route");
  CONTROL_SURFACES.every((s) => needsResidualApproval([s]).needsApproval)
    ? ok(`all ${CONTROL_SURFACES.length} control surfaces stop: ${CONTROL_SURFACES.join(", ")}`)
    : bad("a control surface does not stop");
  !needsResidualApproval(["prompt_wording", "log_format", "queue_batch_size"]).needsApproval
    ? ok("and ordinary changes do not, so the carve-out is not stuck on")
    : bad("everything stops, which is the carve-out stuck in the other position");
  !auth.promote && auth.stage === "approval"
    && needsResidualApproval(["auth"]).why.includes("removing what would have caught")
    ? ok("with the reason being the controls, not the importance")
    : bad("the reason given is 'this is important'");

  console.log("");
  console.log("6. the order the gate runs in");
  /*
   * The approval is checked LAST on purpose: a change failing its acceptance
   * suite should be reported as failing, not as awaiting his approval, or he is
   * asked to approve something broken.
   */
  const brokenAndSensitive = mayPromote({
    acceptanceSuitePassed: false, evalSuitePassed: true,
    migration: { backwardCompatible: true }, touches: ["auth"],
  });
  !brokenAndSensitive.promote && brokenAndSensitive.stage === "canary"
    ? ok("a failing change touching auth is reported as failing, not as awaiting his approval")
    : bad(`order: ${JSON.stringify(brokenAndSensitive)}`);
  const evalFailed = mayPromote({ ...green, acceptanceSuitePassed: true, evalSuitePassed: false, touches: [] });
  !evalFailed.promote && evalFailed.stage === "canary"
    ? ok("and the engineering eval gates it as much as the acceptance suite does")
    : bad("S29 was not a gate");
  const badMigration = mayPromote({
    acceptanceSuitePassed: true, evalSuitePassed: true,
    migration: { backwardCompatible: false }, touches: [],
  });
  !badMigration.promote && badMigration.stage === "migration"
    ? ok("and a non-backward-compatible migration is caught before the approval question")
    : bad(`migration stage: ${JSON.stringify(badMigration)}`);

  console.log("");
  console.log("7. the runner is not updated by a task it is running");
  const fromTask = runnerUpdate({ runnerBusy: true, requestedBy: "running_task" });
  !fromTask.apply && fromTask.why.includes("replacing the thing applying it")
    ? ok(`a task cannot update the runner it lives in: "${fromTask.why}"`)
    : bad(`from task: ${JSON.stringify(fromTask)}`);
  !runnerUpdate({ runnerBusy: false, requestedBy: "running_task" }).apply
    ? ok("and not even when the runner looks idle — it is the asker that is wrong")
    : bad("an idle runner accepted an update from a task inside it");
  !runnerUpdate({ runnerBusy: true, requestedBy: "system_worker" }).apply
    ? ok("the system worker waits for the gap between runs")
    : bad("the runner was updated mid-run");
  const applied = runnerUpdate({ runnerBusy: false, requestedBy: "system_worker" });
  applied.apply && applied.by === "system_worker"
    ? ok("and applies it between runs, which is when the binary actually changes")
    : bad(`update: ${JSON.stringify(applied)}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
