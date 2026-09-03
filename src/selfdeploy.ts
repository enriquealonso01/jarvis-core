/**
 * Deploying its own control plane (plan S54).
 *
 * The handover parked exactly one capability: Jarvis deploying its own
 * `jarvis-core`. Enrique has decided it should do this too — and the step is
 * careful about why that is not simply a relaxation:
 *
 *   "The objection was never bureaucratic — **a bad core deploy takes down the
 *    API, the runner, the broker and the console, which is to say the very things
 *    that would notice, alert, and roll back.** So this step does not answer the
 *    objection by ignoring it. **It answers it by making a bad deploy recover
 *    without a human**, and only then hands over the keys."
 *
 * FOUR RULES, AND EACH IS A DIFFERENT WAY OF NOT TRUSTING THE THING BEING
 * DEPLOYED.
 *
 * ONE: **a check that cannot run counts as failure.** VII.5's health check is not
 * "did the API return 200" — it is the API answering AND the queue dispatching,
 * the runner claiming, a real read and write, the broker decrypting a canary
 * credential, migrations matching the image. And "**a check that cannot run
 * reports `unknown` and counts as failure**", which is the opposite of what an
 * exception handler does by default.
 *
 * TWO: **the restorer does not live inside what it restores.** "The thing doing
 * the restoring is **not** something the deploy just replaced... so it survives a
 * core that never comes up." A rollback wired through the API is a rollback that
 * works for every failure except the one that matters.
 *
 * THREE: **a rollback never restores the database.** "Rolling back the image
 * never restores the database — the inbox is append-only and is the one thing
 * never to lose." So every core migration is backward compatible with the
 * previous image, and one that cannot be is its own deploy with its rollback
 * written first. "**An automatic rollback over a non-reversible migration is an
 * automated way to make things worse.**"
 *
 * FOUR: **the residual approval is about the controls, not about importance.**
 * "The reason is not 'these are important' — everything in core is important. It
 * is that **a wrong change here can disable the very gates, alerts, or stop
 * button every other safety property depends on**... Auto-rollback protects
 * against a deploy that *fails*; it cannot protect against one that *succeeds at
 * removing the thing that would have caught the next one.*"
 *
 * And the Debug note says exactly how that classifier goes wrong: "if the
 * residual approval never fires, **the classifier is matching on file paths
 * instead of on what the change touches** — the auth surface is reachable by more
 * than one path." So `needsResidualApproval` takes SURFACES and there is no path
 * parameter for it to match on.
 */

/* ------------------------------------------------------------------ *
 * The health check, where not-run is not-passed.
 * ------------------------------------------------------------------ */

/** VII.5's checks. Every one of them, not a subset that happens to be easy. */
export const HEALTH_CHECKS = [
  "api_answers",
  "queue_dispatches",
  "runner_claims",
  "db_read_write",
  "broker_decrypts_canary",
  "migrations_match_image",
] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

/** `unknown` is a real outcome here, and it is not a pass. */
export type CheckResult = "pass" | "fail" | "unknown";

export type HealthVerdict = {
  healthy: boolean;
  failed: HealthCheck[];
  unknown: HealthCheck[];
  why: string;
};

/**
 * Did the promoted release actually come up?
 *
 * A check that did not run is `unknown` and counts as FAILURE. That is the whole
 * sentence from VII.5, and it inverts the usual shape: an exception handler that
 * swallows a failed probe reports health, and the deploy that broke the queue is
 * exactly the deploy whose queue probe throws.
 *
 * A missing result is treated the same way as an explicit `unknown` — absence is
 * not a pass either.
 */
export function healthVerdict(results: Partial<Record<HealthCheck, CheckResult>>): HealthVerdict {
  const failed: HealthCheck[] = [];
  const unknown: HealthCheck[] = [];
  for (const check of HEALTH_CHECKS) {
    const r = results[check];
    if (r === "fail") failed.push(check);
    else if (r === "pass") continue;
    else unknown.push(check);
  }
  const healthy = failed.length === 0 && unknown.length === 0;
  return {
    healthy,
    failed,
    unknown,
    why: healthy
      ? "every check ran and passed"
      : [
        failed.length ? `failed: ${failed.join(", ")}` : null,
        unknown.length ? `could not be run, which counts as failure: ${unknown.join(", ")}` : null,
      ].filter(Boolean).join("; "),
  };
}

/* ------------------------------------------------------------------ *
 * The restorer, which does not live inside what it restores.
 * ------------------------------------------------------------------ */

export type SupervisorLocation = "host_unit" | "external_watchdog" | "inside_compose" | "inside_api";

/**
 * Is this rollback path one the deploy could take out with it?
 *
 * The Debug note: "if a bad deploy needs a human to roll back, **the rollback path
 * is wired through something the deploy replaced** — move it out of band."
 *
 * Named rather than inferred, because the failure is invisible in the good case:
 * a rollback wired through the API works perfectly every time except the one time
 * it is needed for an API that never came up.
 */
export function restorerSurvives(where: SupervisorLocation): { survives: boolean; why: string } {
  if (where === "host_unit" || where === "external_watchdog") {
    return {
      survives: true,
      why: `${where.replace("_", " ")} is outside the stack the deploy replaces, so it is still there `
        + "when the new core never comes up",
    };
  }
  return {
    survives: false,
    why: `${where.replace("_", " ")} is part of what a core deploy replaces — it works for every `
      + "failure except the one that matters",
  };
}

export type Rollback = {
  restored: "previous_release";
  /** Never. See the type: there is no value here that includes the database. */
  database: "untouched";
  say: string;
};

/**
 * Put the previous release back.
 *
 * `database` is the literal `"untouched"`. "Rolling back the image never restores
 * the database — the inbox is append-only and is the one thing never to lose." A
 * version of this that could restore the database has to change the type, rather
 * than gaining a flag somebody sets during an incident at three in the morning.
 */
export function rollback(previousRelease: string): Rollback {
  return {
    restored: "previous_release",
    database: "untouched",
    say: `Rolled back to ${previousRelease}. The database was not touched — it never is.`,
  };
}

/* ------------------------------------------------------------------ *
 * Migrations, and the line a rollback cannot cross.
 * ------------------------------------------------------------------ */

export type MigrationPlan = {
  /** Does the PREVIOUS image still work against this schema? */
  backwardCompatible: boolean;
  /** Written before it runs, for the one that is not. */
  rollbackWritten?: boolean;
  /** Taken and verified before it runs (S35). */
  verifiedRestorePoint?: boolean;
};

export type DeployShape =
  | { shape: "ordinary"; why: string }
  | { shape: "its_own_deploy"; ready: boolean; why: string };

/**
 * May this ship as an ordinary autonomous deploy?
 *
 * "Every core migration is backward compatible with the previous image (expand,
 * then contract a deploy later); **a migration that genuinely cannot be is its own
 * deploy, with its rollback written BEFORE it runs and a verified restore point
 * taken first.**"
 *
 * Because auto-rollback restores the image and not the schema: a rollback over a
 * migration the old image cannot read leaves the previous release running against
 * a database it does not understand, which is worse than the outage it was
 * fixing.
 */
export function deployShapeFor(plan: MigrationPlan): DeployShape {
  /*
   * `=== true`, not truthy.
   *
   * A plan arriving from JSON, a row or an env var can carry the STRING "false",
   * which is truthy, and this shipped it as an ordinary deploy - meaning an
   * automatic rollback over a migration the previous image cannot read. The doc
   * above calls that "an automated way to make things worse", and a truthy check
   * was the way in.
   */
  if (plan.backwardCompatible === true) {
    return {
      shape: "ordinary",
      why: "the previous image still runs against this schema, so a rollback is safe",
    };
  }
  const ready = Boolean(plan.rollbackWritten && plan.verifiedRestorePoint);
  return {
    shape: "its_own_deploy",
    ready,
    why: ready
      ? "not backward compatible, so it ships alone with its rollback written and a verified restore "
        + "point taken first"
      : "not backward compatible, and it has no written rollback or no verified restore point — an "
        + "automatic rollback over this would be an automated way to make things worse",
  };
}

/* ------------------------------------------------------------------ *
 * The residual approval, matched on what a change touches.
 * ------------------------------------------------------------------ */

/**
 * The surfaces a change can touch that would remove the ability to correct it.
 *
 * VII.5's list. Note this is a list of SURFACES rather than of files: "the auth
 * surface is reachable by more than one path", and a classifier keyed on paths
 * misses the second one.
 */
export const CONTROL_SURFACES = ["auth", "isolation", "backups", "spend", "kill_switch"] as const;
export type ControlSurface = (typeof CONTROL_SURFACES)[number];

export function isControlSurface(s: string): s is ControlSurface {
  return (CONTROL_SURFACES as readonly string[]).includes(s);
}

export type ApprovalVerdict = {
  needsApproval: boolean;
  surfaces: ControlSurface[];
  why: string;
};

/**
 * Does this change stop for him, even with everything green?
 *
 * Takes what the change TOUCHES. There is no `paths` parameter, which is the
 * Debug note's failure made unwritable: a classifier matching `src/auth.ts`
 * misses the isolation check that also gates auth, and misses it silently.
 *
 * "It is the smallest possible human-in-the-loop: not *'Enrique approves
 * deploys'*, but *'Enrique approves changes to the controls that keep him in the
 * loop'*."
 */
export function needsResidualApproval(touches: string[]): ApprovalVerdict {
  const surfaces = touches.filter(isControlSurface);
  if (!surfaces.length) {
    return {
      needsApproval: false,
      surfaces: [],
      why: "this touches nothing that could disable the gates, alerts or stop button",
    };
  }
  return {
    needsApproval: true,
    surfaces,
    why: `this touches ${surfaces.join(", ")} — auto-rollback protects against a deploy that fails, `
      + "not against one that succeeds at removing what would have caught the next one",
  };
}

/* ------------------------------------------------------------------ *
 * The runner is not updated by a task it is running.
 * ------------------------------------------------------------------ */

export type RunnerUpdate =
  | { apply: true; by: "system_worker"; why: string }
  | { apply: false; why: string };

/**
 * When does the runner's binary actually change?
 *
 * "**The runner is not updated by a task it is running** — runner updates apply
 * between runs, by the system worker." The plan says to "assert on when the binary
 * actually changed, not on the intent", so this returns the decision rather than
 * a promise: a runner mid-task is refused, whoever is asking.
 */
export function runnerUpdate(args: {
  runnerBusy: boolean;
  requestedBy: "system_worker" | "running_task";
}): RunnerUpdate {
  if (args.requestedBy === "running_task") {
    return {
      apply: false,
      why: "a task cannot update the runner it is running inside — that is the update replacing the "
        + "thing applying it",
    };
  }
  /*
   * Only the system worker, proven rather than assumed.
   *
   * This refused `running_task` and let EVERYTHING ELSE through, so any requester
   * that was neither string - a renamed caller, a value off a queue, an empty
   * string - got `{apply: true, by: "system_worker"}`. Not merely permissive:
   * the answer then NAMES the system worker as the actor, so the audit row says
   * the update came from the one caller allowed to make it.
   *
   * The refusal is written as an allow-list for the same reason `restorerSurvives`
   * is, twenty lines up: it names the two places that survive and everything else
   * is false. A deny-list of one is right about the caller somebody thought of.
   */
  if (args.requestedBy !== "system_worker") {
    return {
      apply: false,
      why: `${JSON.stringify(args.requestedBy)} is not the system worker, and the runner's binary `
        + "changes only between runs, by the one caller that is not inside it",
    };
  }
  if (args.runnerBusy) {
    return { apply: false, why: "the runner is mid-run; the update waits for the gap between runs" };
  }
  return { apply: true, by: "system_worker", why: "applied between runs by the system worker" };
}

/* ------------------------------------------------------------------ *
 * The whole gate.
 * ------------------------------------------------------------------ */

export type PromotionDecision =
  | { promote: true; why: string }
  | { promote: false; why: string; stage: "canary" | "approval" | "migration" };

/**
 * Everything, in the order the plan gives.
 *
 * Canary first — "prod core is never the first place a change runs" — then the
 * migration shape, then the residual approval. The approval is checked LAST on
 * purpose: a change that fails its acceptance suite should be reported as
 * failing, not as awaiting his approval, or he is asked to approve something
 * broken.
 */
export function mayPromote(args: {
  acceptanceSuitePassed: boolean;
  evalSuitePassed: boolean;
  migration: MigrationPlan;
  touches: string[];
}): PromotionDecision {
  /*
   * Proven green, not merely not-falsy.
   *
   * This is rule ONE of this file applied to the file's own inputs: "a check that
   * cannot run reports `unknown` and counts as failure". `!args.acceptanceSuitePassed`
   * is false for the string "false", for "no", for "0" and for "off" - so a
   * serialised result that says the canary FAILED promoted the release to prod
   * core. `healthVerdict` already refuses to read absence as a pass; the gate in
   * front of it was reading a failure as one.
   */
  if (args.acceptanceSuitePassed !== true || args.evalSuitePassed !== true) {
    return {
      promote: false,
      stage: "canary",
      why: "the canary did not pass S8 and S29 — prod core is never the first place a change runs",
    };
  }
  const shape = deployShapeFor(args.migration);
  if (shape.shape === "its_own_deploy") {
    return { promote: false, stage: "migration", why: shape.why };
  }
  const approval = needsResidualApproval(args.touches);
  if (approval.needsApproval) {
    return { promote: false, stage: "approval", why: approval.why };
  }
  return { promote: true, why: "green on the canary, backward compatible, and touching no control surface" };
}
