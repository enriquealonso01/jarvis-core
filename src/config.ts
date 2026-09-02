/**
 * S27 — configuration by conversation.
 *
 * "Stop doing X", "always do Y in project Z", "change Alpha's deploy policy"
 * have to become real, versioned, reversible changes — to any project, from
 * wherever Enrique happens to be.
 *
 * The step's Debug section names the failure mode and the cure in one sentence:
 * "If a change applies but does not show in history, the write is bypassing the
 * versioning path. Every config write goes through one function; find the one
 * that does not." So this module IS that one function. `applyConfigChange` is
 * the only way a configuration value changes, and versioning, provenance and
 * audit are not things a caller can forget to do — they are the same statement
 * as the write.
 *
 * Three things it refuses, and each refusal is total rather than partial:
 *
 * 1. **The immutable list (§59).** Isolation, authentication, audit, backup,
 *    spend ceilings, the always-confirm list, secret scope, and the authority of
 *    system projects. Jarvis may recommend changes to these and may never make
 *    them. A refusal raises an approval so the recommendation is not lost.
 * 2. **Ambiguity.** A garbled instruction gets one clarifying question and
 *    changes nothing. "A half-applied config change is worse than none."
 * 3. **Nonsense values.** A key with a validator gets checked before it is
 *    written, not after.
 *
 * Rollback never mutates history: restoring version 3 writes version 7 whose
 * value equals version 3's. What happened, happened, and the record of it is
 * how "what changed last week" stays answerable.
 */
import type pg from "pg";

export type ConfigScope = "global" | "project";

/**
 * The immutable list, as prefixes.
 *
 * Written as data rather than as a chain of `if`s so that the test can assert
 * over the whole list, and so that adding a protected domain is one line in one
 * place. The match is on the key's first segment or an exact key: a
 * configuration key is `domain.thing`, and a domain is protected whole — there
 * is no such thing as protecting `isolation` but not `isolation.cross_project`.
 */
export const IMMUTABLE_DOMAINS: Record<string, string> = {
  isolation: "project isolation",
  auth: "authentication",
  authentication: "authentication",
  audit: "the audit log",
  backup: "backups",
  backups: "backups",
  spend: "spend ceilings",
  always_confirm: "the always-confirm list",
  secrets: "secret scope",
  secret_scope: "secret scope",
  system_project: "the authority of the system projects",
};

/**
 * Individual keys that are immutable even though their domain is not. A project
 * row carries its own spend ceiling and its own metered flag; those are §59
 * whatever namespace they are written under.
 */
export const IMMUTABLE_KEYS: Record<string, string> = {
  spend_ceiling_cents: "spend ceilings",
  metered_spend_allowed: "spend ceilings",
  confidentiality_eligibility: "project isolation",
  "project.confidentiality": "project isolation",
  "project.is_system": "the authority of the system projects",
};

/** The protected domain a key belongs to, or null if it is ordinary config. */
export function immutableDomain(key: string): string | null {
  const k = key.trim().toLowerCase();
  if (IMMUTABLE_KEYS[k]) return IMMUTABLE_KEYS[k];
  return IMMUTABLE_DOMAINS[k.split(/[.:]/)[0]] ?? null;
}

export type ConfigOutcome =
  | { applied: true; versionId: string; version: number }
  | { applied: false; refused: "immutable"; domain: string; reason: string; issueId: string | null }
  | { applied: false; refused: "ambiguous"; question: string }
  | { applied: false; refused: "invalid"; reason: string };

export type ConfigChange = {
  scope: ConfigScope;
  projectId: string | null;
  key: string;
  value: unknown;
  actor: string;
  note: string;
  conversationId?: string | null;
  /** Enrique's own words, so the history can answer "why". */
  causedByMessage?: string | null;
  /**
   * Set when the caller could not tell what was meant. Carrying it here rather
   * than making the caller branch means the "one clarifying question, nothing
   * applied" rule is enforced at the write, where it cannot be skipped.
   */
  ambiguous?: string | null;
};

/**
 * The only way configuration changes.
 *
 * Everything else — a Supervisor tool, an API route, a rollback — calls this.
 */
export async function applyConfigChange(
  pool: pg.Pool,
  change: ConfigChange,
): Promise<ConfigOutcome> {
  const key = change.key.trim();
  if (!key) return { applied: false, refused: "invalid", reason: "no configuration key given" };

  if (change.ambiguous) {
    /*
     * Nothing is written, not even a record of the attempt: an ambiguous
     * sentence is not a change that failed, it is a question that has not been
     * answered yet.
     */
    return { applied: false, refused: "ambiguous", question: change.ambiguous };
  }

  if (change.scope === "project" && !change.projectId) {
    return { applied: false, refused: "invalid", reason: "a project-scoped change needs a project" };
  }

  const domain = immutableDomain(key);
  if (domain) {
    /*
     * §59. Refused, and recommended: the plan says Jarvis "may recommend
     * changes to these; it may never make them", so throwing the instruction
     * away would be as wrong as obeying it. The approval carries his own words
     * so he can act on it without reconstructing what he asked for.
     */
    const { raiseIssue } = await import("./notify.js");
    const reason = `${key} is ${domain}, which cannot be changed by an instruction`;
    const issue = await raiseIssue(pool, {
      category: "security.broker_deny",
      service: "config",
      owner: "user",
      status: "waiting_for_user",
      title: `[approval] Change to ${domain} needs you`,
      dedupeKey: `config.immutable.${key}.${change.conversationId ?? "none"}`,
      projectId: change.projectId,
      evidence: {
        key,
        requested_value: change.value,
        asked: change.causedByMessage ?? change.note,
        conversation_id: change.conversationId ?? null,
      },
      requiredAction:
        `Jarvis was asked to change ${key} (${domain}) and refused, because §59 makes it `
        + "immutable without your approval. Nothing was applied. If you want this, make the "
        + "change yourself and it will be recorded as yours.",
    });
    await audit(pool, change, "denied", { key, domain, reason });
    return { applied: false, refused: "immutable", domain, reason, issueId: issue.issueId };
  }

  const validation = validateValue(key, change.value);
  if (validation) return { applied: false, refused: "invalid", reason: validation };

  /*
   * The version number is per (project, key) — it used to be computed with
   * max(version) over the key across every project, so two projects sharing a
   * key name shared one sequence and neither one's history read correctly.
   */
  const inserted = await pool.query<{ id: string; version: number }>(
    `INSERT INTO config_versions
       (scope, project_id, key, value, version, actor, note, conversation_id,
        caused_by_message, supersedes)
     VALUES ($1, $2, $3, $4,
             COALESCE((SELECT max(version) FROM config_versions
                       WHERE key = $3 AND project_id IS NOT DISTINCT FROM $2), 0) + 1,
             $5, $6, $7, $8,
             (SELECT id FROM config_versions
              WHERE key = $3 AND project_id IS NOT DISTINCT FROM $2
              ORDER BY version DESC LIMIT 1))
     RETURNING id, version`,
    [
      change.scope,
      change.projectId,
      key,
      JSON.stringify(change.value),
      change.actor,
      change.note,
      change.conversationId ?? null,
      change.causedByMessage ?? null,
    ],
  );

  await audit(pool, change, "allowed", {
    key,
    version: inserted.rows[0].version,
    value: change.value,
  });

  return { applied: true, versionId: inserted.rows[0].id, version: inserted.rows[0].version };
}

/**
 * Restore a previous version by writing a new one.
 *
 * "Roll a change back and confirm the previous version is restored exactly."
 * Exactly means the stored value, byte for byte, not a re-derivation of it — so
 * this reads the old row and replays its value rather than reconstructing what
 * the value ought to have been.
 */
export async function rollbackConfig(
  pool: pg.Pool,
  args: {
    projectId: string | null;
    key: string;
    toVersion: number;
    actor: string;
    conversationId?: string | null;
    causedByMessage?: string | null;
  },
): Promise<ConfigOutcome> {
  const old = await pool.query<{ value: unknown; scope: ConfigScope }>(
    `SELECT value, scope FROM config_versions
     WHERE key = $1 AND project_id IS NOT DISTINCT FROM $2 AND version = $3`,
    [args.key, args.projectId, args.toVersion],
  );
  if (!old.rows[0]) {
    return { applied: false, refused: "invalid", reason: `no version ${args.toVersion} of ${args.key}` };
  }
  return applyConfigChange(pool, {
    scope: old.rows[0].scope,
    projectId: args.projectId,
    key: args.key,
    value: old.rows[0].value,
    actor: args.actor,
    note: `rolled back to version ${args.toVersion}`,
    conversationId: args.conversationId,
    causedByMessage: args.causedByMessage,
  });
}

export type ConfigHistoryRow = {
  version: number;
  key: string;
  value: unknown;
  at: string;
  actor: string;
  note: string | null;
  caused_by_message: string | null;
  conversation_id: string | null;
};

/**
 * "What changed in Alpha's policy last week?"
 *
 * Answered from the version rows, newest first, optionally since a moment and
 * optionally for one key. The caller renders it; this decides what counts.
 */
export async function configHistory(
  pool: pg.Pool,
  args: { projectId?: string | null; key?: string; since?: Date; limit?: number },
): Promise<ConfigHistoryRow[]> {
  const r = await pool.query<ConfigHistoryRow>(
    `SELECT version, key, value, at::text AS at, actor, note, caused_by_message, conversation_id
     FROM config_versions
     WHERE ($1::uuid IS NULL OR project_id = $1)
       AND ($2::text IS NULL OR key = $2)
       AND ($3::timestamptz IS NULL OR at >= $3)
     ORDER BY at DESC, version DESC
     LIMIT $4`,
    [args.projectId ?? null, args.key ?? null, args.since?.toISOString() ?? null, args.limit ?? 50],
  );
  return r.rows;
}

/**
 * A project's instructions are configuration too, but they live in their own
 * table because ADR 018 made that row canonical and S6 reads it. Same rules:
 * one function, a new version rather than an edit, provenance recorded.
 */
export async function applyInstructionsChange(
  pool: pg.Pool,
  args: {
    projectId: string;
    body: string;
    actor: "user" | "jarvis";
    conversationId?: string | null;
    causedByMessage?: string | null;
  },
): Promise<{ version: number } | { error: string }> {
  const body = args.body.trim();
  if (!body) return { error: "refusing to store empty instructions" };
  if (/\{\{[a-z_]+\}\}/.test(body)) {
    // The S26 rule, enforced on every later version and not only the first: a
    // placeholder means somebody rendered without an answer.
    return { error: "instructions still contain a template placeholder" };
  }
  const r = await pool.query<{ version: number }>(
    `INSERT INTO project_instructions_versions
       (project_id, version, body, created_by, conversation_id, caused_by_message)
     VALUES ($1,
             COALESCE((SELECT max(version) FROM project_instructions_versions
                       WHERE project_id = $1), 0) + 1,
             $2, $3, $4, $5)
     RETURNING version`,
    [args.projectId, body, args.actor, args.conversationId ?? null, args.causedByMessage ?? null],
  );
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, project_id, metadata)
     VALUES ($1, 'config.instructions_change', 'AGENTS.md', $2, $3)`,
    [args.actor, args.projectId,
     JSON.stringify({ version: r.rows[0].version, conversation_id: args.conversationId ?? null,
                      asked: args.causedByMessage ?? null })],
  );
  return { version: r.rows[0].version };
}

/** Restore an instructions version exactly, as a new version. */
export async function rollbackInstructions(
  pool: pg.Pool,
  args: {
    projectId: string; toVersion: number; actor: "user" | "jarvis";
    conversationId?: string | null;
  },
): Promise<{ version: number } | { error: string }> {
  const old = await pool.query<{ body: string }>(
    `SELECT body FROM project_instructions_versions WHERE project_id = $1 AND version = $2`,
    [args.projectId, args.toVersion],
  );
  if (!old.rows[0]) return { error: `no version ${args.toVersion}` };
  return applyInstructionsChange(pool, {
    projectId: args.projectId,
    body: old.rows[0].body,
    actor: args.actor,
    conversationId: args.conversationId,
    causedByMessage: `rolled back to version ${args.toVersion}`,
  });
}

/** Keys with a known shape are checked before the write, not after. */
function validateValue(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return `${key} needs a value`;
  if (key === "queue.default_priority") {
    const allowed = ["critical", "high", "normal", "low", "background"];
    if (typeof value !== "string" || !allowed.includes(value)) {
      return `queue.default_priority must be one of ${allowed.join(", ")}`;
    }
  }
  if (key.startsWith("schedule:") && typeof value === "object" && value !== null) {
    const cron = (value as { cron?: unknown }).cron;
    if (cron !== undefined && (typeof cron !== "string" || cron.trim().split(/\s+/).length !== 5)) {
      return "a cron expression has five fields";
    }
  }
  return null;
}

async function audit(
  pool: pg.Pool,
  change: ConfigChange,
  outcome: "allowed" | "denied",
  extra: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, project_id, metadata)
     VALUES ($1, 'config.change', $2, $3, $4)`,
    [change.actor, change.key, change.projectId,
     JSON.stringify({ outcome, conversation_id: change.conversationId ?? null,
                      asked: change.causedByMessage ?? null, ...extra })],
  );
}
