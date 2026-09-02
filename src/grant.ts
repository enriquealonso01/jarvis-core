import type pg from "pg";

/**
 * Natural-language task grants, and the eight ways they die (plan S10, IV.6,
 * v1 §13.2).
 *
 * "Fix this, PR it, merge it" pre-authorises named Level 1 and Level 2 actions
 * for **that task, that repository, that commit, that environment**, with an
 * expiry. It can never reach Level 3.
 *
 * Two sentences from the plan decide the shape of this file:
 *
 *   "The model does not decide whether approval is required — the policy engine
 *    does."
 *   "In the broker, before the action — not in the prompt, not in the UI, and
 *    never by asking the model to check itself."
 *
 * So nothing here takes the model's word for anything. The caller supplies
 * facts — the SHA it is about to act on, the environment, whether a destructive
 * migration appeared — and this decides. A Level 3 action reaching here without
 * a live approval is refused whatever the task believed it had been told.
 */

/** Level 3. A grant never authorises these; each needs Enrique, every time. */
export const LEVEL_3 = new Set([
  "merge_production",
  "deploy_production",
  "send_external_email",
  "delete_production_data",
  "modify_production_database",
  "purchase",
  "publish_social",
  "change_infrastructure",
  "rotate_credentials",
]);

/** Level 2. Reversible, external; a grant may authorise these. */
export const LEVEL_2 = new Set([
  "merge",
  "deploy_staging",
  "create_github_issue",
  "modify_dev_database",
  "post_internal",
  "send_draft",
]);

export type GrantSignals = {
  /** The commit the action is about to be taken on. */
  sha?: string | null;
  environment?: string | null;
  repo?: string | null;
  /** 2. the task now covers materially more than it was granted for */
  scopeExpanded?: boolean;
  /** 3. a destructive migration appeared in the diff */
  destructiveMigration?: boolean;
  /** 4. the change weakens a security control */
  weakensSecurity?: boolean;
  /** 5. shipping it would turn on paid billing */
  enablesBilling?: boolean;
  /** 6. secrets or permissions changed materially */
  secretsChanged?: boolean;
};

export type GrantDecision =
  | { allowed: true; grantId: string; level: 1 | 2 }
  | { allowed: false; code: string; reason: string; invalidated: boolean };

export function levelOf(action: string): 1 | 2 | 3 {
  if (LEVEL_3.has(action)) return 3;
  if (LEVEL_2.has(action)) return 2;
  return 1;
}

export async function createTaskGrant(
  pool: pg.Pool,
  args: {
    taskId: string;
    projectId: string;
    actions: string[];
    repo: string | null;
    environment: string | null;
    allowedSha: string | null;
    ttlMinutes?: number;
    sourceInboxId?: string | null;
  },
): Promise<{ id: string } | { error: string }> {
  // A grant that names a Level 3 action is not narrowed to its legal parts — it
  // is refused. Silently granting the Level 2 half of "merge it and deploy to
  // production" would be a system that heard "deploy to production" and said
  // nothing.
  const illegal = args.actions.filter((a) => levelOf(a) === 3);
  if (illegal.length) {
    return {
      error:
        `a natural-language grant cannot authorise ${illegal.join(", ")}. `
        + "Production actions need a live approval at the point of action, every time.",
    };
  }
  const r = await pool.query<{ id: string }>(
    `INSERT INTO task_grants
       (task_id, project_id, actions, repo, environment, allowed_sha, expires_at, source_inbox_id)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7), $8)
     RETURNING id`,
    [
      args.taskId,
      args.projectId,
      args.actions,
      args.repo,
      args.environment,
      args.allowedSha,
      args.ttlMinutes ?? 120,
      args.sourceInboxId ?? null,
    ],
  );
  return { id: r.rows[0].id };
}

async function invalidate(
  pool: pg.Pool,
  grantId: string,
  reason: string,
): Promise<void> {
  await pool
    .query(
      `UPDATE task_grants SET invalidated_at = now(), invalidate_reason = $2
       WHERE id = $1 AND invalidated_at IS NULL`,
      [grantId, reason],
    )
    .catch(() => undefined);
}

async function audit(
  pool: pg.Pool,
  action: string,
  target: string,
  projectId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('broker', $1, $2, $3, $4)`,
      [action, target, projectId, JSON.stringify(metadata)],
    )
    .catch(() => undefined);
}

/**
 * May this action proceed on the strength of a grant?
 *
 * Every refusal is audited, because a decision nobody can read afterwards is
 * indistinguishable from one that was never made.
 */
export async function checkGrant(
  pool: pg.Pool,
  args: { taskId: string; action: string; signals?: GrantSignals },
): Promise<GrantDecision> {
  const s = args.signals ?? {};
  const level = levelOf(args.action);

  const t = await pool.query<{
    project_id: string | null;
    project_type: string | null;
    production_status: string | null;
    may_deploy_prod: boolean | null;
  }>(
    `SELECT t.project_id, p.project_type, p.production_status,
            p.nl_grant_may_deploy_production AS may_deploy_prod
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
    [args.taskId],
  );
  const ctx = t.rows[0];
  const projectId = ctx?.project_id ?? null;

  const deny = async (code: string, reason: string, invalidated = false): Promise<GrantDecision> => {
    await audit(pool, `grant.${code}`, args.action, projectId, {
      task_id: args.taskId,
      reason,
      level,
      ...s,
    });
    return { allowed: false, code, reason, invalidated };
  };

  // Level 3 first, before any grant is even looked at. A grant cannot buy this,
  // however recently it was issued and however clearly it was worded.
  if (level === 3) {
    return deny(
      "approval_required",
      `${args.action} is a production action. A natural-language grant never authorises it; `
        + "it needs a live approval at the point of action.",
    );
  }

  // N6: a professional project does not ship production on a grant at all, and
  // the flag that would allow it defaults off everywhere.
  const productionish =
    s.environment === "production" || ctx?.production_status === "production";
  if (productionish) {
    if (ctx?.project_type === "professional") {
      return deny(
        "approval_required",
        "this is a professional project in production. Natural-language grants do not reach it.",
      );
    }
    if (!ctx?.may_deploy_prod) {
      return deny(
        "approval_required",
        "nl_grant_may_deploy_production is off for this project, so a grant does not authorise "
          + "a production action.",
      );
    }
  }

  const g = await pool.query<{
    id: string;
    actions: string[];
    repo: string | null;
    environment: string | null;
    allowed_sha: string | null;
    expires_at: Date | null;
    invalidated_at: Date | null;
    invalidate_reason: string | null;
  }>(
    `SELECT id, actions, repo, environment, allowed_sha, expires_at, invalidated_at, invalidate_reason
     FROM task_grants WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [args.taskId],
  );
  const grant = g.rows[0];
  if (!grant) return deny("no_grant", "no grant was issued for this task");
  if (grant.invalidated_at) {
    return deny("invalidated", grant.invalidate_reason ?? "the grant was already invalidated", true);
  }
  if (!grant.actions.includes(args.action)) {
    return deny("not_granted", `the grant does not cover ${args.action}`);
  }

  // --- the eight conditions, in the order the plan lists them --------------

  // 1. Project or environment is ambiguous.
  if (!projectId) {
    await invalidate(pool, grant.id, "project is ambiguous");
    return deny("ambiguous_target", "the task has no project, so the target is ambiguous", true);
  }
  if (grant.environment && s.environment && grant.environment !== s.environment) {
    await invalidate(pool, grant.id, "environment is ambiguous");
    return deny(
      "ambiguous_target",
      `the grant was for ${grant.environment}, this action is for ${s.environment}`,
      true,
    );
  }

  // 2. Scope materially expands.
  if (s.scopeExpanded) {
    await invalidate(pool, grant.id, "scope materially expanded");
    return deny("scope_expanded", "the task now covers materially more than was granted", true);
  }

  // 3. A new destructive database migration appears.
  if (s.destructiveMigration) {
    await invalidate(pool, grant.id, "a destructive migration appeared");
    return deny("destructive_migration", "the change contains a destructive migration", true);
  }

  // 4. Security controls must be weakened.
  if (s.weakensSecurity) {
    await invalidate(pool, grant.id, "security controls would be weakened");
    return deny("weakens_security", "the change weakens a security control", true);
  }

  // 5. Paid billing must be enabled.
  if (s.enablesBilling) {
    await invalidate(pool, grant.id, "paid billing would be enabled");
    return deny("enables_billing", "shipping this would turn on paid billing", true);
  }

  // 6. Secrets or permissions change materially.
  if (s.secretsChanged) {
    await invalidate(pool, grant.id, "secrets or permissions changed");
    return deny("secrets_changed", "secrets or permissions changed materially", true);
  }

  // 7. The branch/commit changes after validation.
  //    Bound to the COMMIT, not the task: a grant that survives an amend is
  //    authorising code nobody approved.
  if (grant.allowed_sha && s.sha && grant.allowed_sha !== s.sha) {
    await invalidate(pool, grant.id, "the commit changed after the grant was issued");
    return deny(
      "sha_changed",
      `the grant was for ${grant.allowed_sha.slice(0, 8)}, this is ${s.sha.slice(0, 8)}`,
      true,
    );
  }
  if (grant.repo && s.repo && grant.repo !== s.repo) {
    await invalidate(pool, grant.id, "the repository changed");
    return deny("repo_changed", `the grant was for ${grant.repo}, this is ${s.repo}`, true);
  }

  // 8. The task is resumed after the grant expires.
  if (grant.expires_at && grant.expires_at.getTime() < Date.now()) {
    await invalidate(pool, grant.id, "the grant expired");
    return deny("expired", "the grant expired before this action was taken", true);
  }

  await audit(pool, "grant.allowed", args.action, projectId, {
    task_id: args.taskId,
    grant_id: grant.id,
    level,
    sha: s.sha ?? null,
  });
  return { allowed: true, grantId: grant.id, level: level as 1 | 2 };
}

/** Mark a grant used, so a second use is visible rather than inferred. */
export async function consumeGrant(pool: pg.Pool, grantId: string, action: string): Promise<void> {
  await pool
    .query(
      `UPDATE task_grants SET consumed_at = now(), consumed_action = $2
       WHERE id = $1 AND consumed_at IS NULL`,
      [grantId, action],
    )
    .catch(() => undefined);
}
