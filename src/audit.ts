import type pg from "pg";

/**
 * The audit trail, with keys that are a contract rather than a convention
 * (IV.9, S12b item 6).
 *
 * `audit_events` has six columns, so most of what IV.9 requires lives inside the
 * `metadata` JSON — "that is workable, but only if the keys are fixed: free-form
 * metadata means two writers name the same thing differently, and 'every action
 * on task X' stops being answerable a month after anyone would notice."
 *
 * Thirty-six call sites wrote that JSON by hand, each choosing its own names,
 * and `outcome` — the key IV.9 calls required on every row — appeared on almost
 * none of them. "An audit trail that records attempts and not results answers
 * 'what was tried' and not 'what happened', and the second question is the one
 * asked during an incident."
 *
 * So `outcome` is a required PARAMETER here, not a defaulted one. A default
 * would make every unconverted row claim success, which is worse than an
 * obviously missing key.
 */

/** IV.9: `allowed` · `denied` · `failed`. Required on every row. */
export type Outcome = "allowed" | "denied" | "failed";

export type AuditEntry = {
  /** Who or what initiated it: `user`, `supervisor`, `runner`, `broker`, `worker`… */
  actor: string;
  /** Dotted, past tense where it reads naturally: `credential.store`, `task.cancel`. */
  action: string;
  /** What it was done to — a slug, an id, a name. */
  target?: string | null;
  projectId?: string | null;

  /** Required. What actually happened, not what was attempted. */
  outcome: Outcome;
  /** Required on any denial or failure: short, human, and never a secret. */
  reason?: string | null;

  taskId?: string | null;
  conversationId?: string | null;
  /** Which one, by id — not "a model". */
  model?: string | null;
  harness?: string | null;
  authProfile?: string | null;
  /** The capability used, for a tool or broker invocation. */
  tool?: string | null;
  /** The live approval that authorised an always-confirm action. */
  approvalId?: string | null;
  /** Anything else. Canonical keys above always win over this. */
  extra?: Record<string, unknown>;
};

/**
 * Write one audit row.
 *
 * Never throws: an audit write that takes the action down with it is worse than
 * a missing row, and the row is written in the same call as the action wherever
 * the storage allows it. It logs loudly instead, because a silently missing
 * audit row is the thing IV.9 exists to prevent.
 */
export async function audit(pool: pg.Pool, entry: AuditEntry): Promise<void> {
  const metadata: Record<string, unknown> = {
    ...(entry.extra ?? {}),
    outcome: entry.outcome,
  };
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") metadata[key] = value;
  };
  put("reason", entry.reason);
  put("task_id", entry.taskId);
  put("conversation_id", entry.conversationId);
  put("model", entry.model);
  put("harness", entry.harness);
  put("auth_profile", entry.authProfile);
  put("tool", entry.tool);
  put("approval_id", entry.approvalId);

  await pool
    .query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.actor, entry.action, entry.target ?? null, entry.projectId ?? null, JSON.stringify(metadata)],
    )
    .catch((err) => {
      console.error(
        `AUDIT WRITE FAILED for ${entry.actor}/${entry.action}:`,
        err instanceof Error ? err.message : err,
      );
    });
}

/**
 * The actions IV.9 names as the minimum that must be attributable.
 *
 * Written down as data so the test can assert each one produces a row with the
 * contract's keys, rather than a reader having to trust that it does.
 */
export const IV9_MINIMUM = [
  // "provider added" and "secret updated" are the same event here: a provider
  // arrives by storing its credential, which creates the connection with it.
  "credential.store",        // secret updated, provider added
  "approval.approve",        // production approval granted
  "model.change",            // model changed
  "schedule.update",         // schedule changed
  "task.cancel",             // task cancelled
  "github.merge_pull_request", // PR merged
  "security.isolation",      // connection denied
] as const;
