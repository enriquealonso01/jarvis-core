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
import { audit } from "./audit.js";

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
  // Both lookups guard against inherited keys. `immutableDomain("constructor")`
  // returned the Object constructor - a function where the signature promises
  // `string | null`, which then travels into a refusal's `domain` field and an
  // audit row. It failed CLOSED, so nothing was wrongly permitted; it was
  // simply not answering the question it was asked. Note the lowercasing above
  // hides most of this by accident: only `constructor` and `__proto__` survive
  // it unchanged, which is exactly the kind of accident not to rely on.
  if (Object.hasOwn(IMMUTABLE_KEYS, k)) return IMMUTABLE_KEYS[k];
  const domain = k.split(/[.:]/)[0];
  return Object.hasOwn(IMMUTABLE_DOMAINS, domain) ? IMMUTABLE_DOMAINS[domain] : null;
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
    await auditConfigChange(pool, change, "denied", { key, domain, reason });
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

  await auditConfigChange(pool, change, "allowed", {
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
    /**
     * The answers this body was rendered from, carried forward so the NEXT
     * change has something to edit. A version without them is a dead end: the
     * file can still be read, but "change the deploy policy" has nothing to
     * change except the prose.
     */
    parsedPolicy?: Record<string, string> | null;
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
       (project_id, version, body, created_by, conversation_id, caused_by_message, parsed_policy)
     VALUES ($1,
             COALESCE((SELECT max(version) FROM project_instructions_versions
                       WHERE project_id = $1), 0) + 1,
             $2, $3, $4, $5,
             -- Carry the previous answers forward when the caller has none, so
             -- a hand-written body does not strand the project's edit history.
             COALESCE($6::jsonb, (SELECT parsed_policy FROM project_instructions_versions
                                  WHERE project_id = $1 ORDER BY version DESC LIMIT 1)))
     RETURNING version`,
    [args.projectId, body, args.actor, args.conversationId ?? null, args.causedByMessage ?? null,
     args.parsedPolicy ? JSON.stringify(args.parsedPolicy) : null],
  );
  await audit(
    pool, {
      actor: args.actor,
      action: "config.instructions_change",
      target: "AGENTS.md",
      projectId: args.projectId,
      outcome: "allowed",
      conversationId: args.conversationId ?? null,
      extra: { version: r.rows[0].version, asked: args.causedByMessage ?? null },
    },
  );
  return { version: r.rows[0].version };
}

/**
 * Change ONE answer in a project's instructions, and re-render the file.
 *
 * "Change Alpha's deploy policy" must not become a model rewriting a policy
 * document freehand. The answers that produced `AGENTS.md` are kept on the
 * version row (`parsed_policy`), so a spoken change edits an answer and the
 * file is rendered from the template again — the same renderer, the same
 * completeness check, no opportunity to quietly drop a section or invent one.
 *
 * What Enrique says becomes the VALUE of a named field. Everything else about
 * the file is mechanical.
 */
export async function applyInstructionsField(
  pool: pg.Pool,
  args: {
    projectId: string;
    field: string;
    value: string;
    actor: "user" | "jarvis";
    conversationId?: string | null;
    causedByMessage?: string | null;
  },
): Promise<{ version: number; body: string } | { error: string }> {
  const { AGENTS_FIELDS, renderAgentsMd } = await import("./agentsfile.js");
  const field = args.field.trim();
  if (!(AGENTS_FIELDS as readonly string[]).includes(field)) {
    return { error: `${field} is not part of AGENTS.md. Fields: ${AGENTS_FIELDS.join(", ")}` };
  }
  const value = args.value.trim();
  if (!value) return { error: `${field} needs a value; "none" is how you say there is none` };

  const latest = await pool.query<{ parsed_policy: Record<string, string> | null }>(
    `SELECT parsed_policy FROM project_instructions_versions
     WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
    [args.projectId],
  );
  const answers = latest.rows[0]?.parsed_policy;
  if (!answers) {
    /*
     * No answers to edit means this project was never onboarded through S26.
     * Rendering from a blank slate would produce a file full of guesses, so the
     * honest outcome is to say the project has no instructions to change.
     */
    return { error: "this project has no recorded onboarding answers to change; onboard it first" };
  }

  // `name` is the onboarding field; `project_name` is the template placeholder.
  const merged: Record<string, string> = { ...answers, project_name: answers.name ?? answers.project_name };
  merged[field] = value;

  const rendered = renderAgentsMd(merged as never);
  if (!rendered.ok) {
    return { error: `cannot re-render AGENTS.md — still unanswered: ${rendered.missing.join(", ")}` };
  }

  const written = await applyInstructionsChange(pool, {
    projectId: args.projectId,
    body: rendered.body,
    actor: args.actor,
    conversationId: args.conversationId,
    causedByMessage: args.causedByMessage,
    parsedPolicy: merged,
  });
  if ("error" in written) return written;
  return { version: written.version, body: rendered.body };
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

/**
 * Push the project's current instructions into its repository.
 *
 * Called after a change, never instead of one: the row is canonical (ADR 018)
 * and is already written by the time this runs, so a GitHub failure leaves the
 * change made and the file stale rather than losing the change. It returns a
 * fragment for the caller's reply instead of throwing, because "I changed it but
 * could not commit it" is something Enrique needs told, not an exception.
 */
export async function commitInstructions(
  pool: pg.Pool,
  projectId: string,
  message: string,
): Promise<string> {
  const row = await pool.query<{
    body: string; version: number; github_owner: string | null;
    github_repo: string | null; slug: string;
  }>(
    `SELECT v.body, v.version, p.github_owner, p.github_repo, p.slug
     FROM project_instructions_versions v
     JOIN projects p ON p.id = v.project_id
     WHERE v.project_id = $1 ORDER BY v.version DESC LIMIT 1`,
    [projectId],
  );
  const r = row.rows[0];
  if (!r) return "";
  if (!r.github_owner || !r.github_repo) return ", not committed (no repository)";

  const { githubPutFile } = await import("./github.js");
  const put = await githubPutFile(pool, {
    owner: r.github_owner,
    repo: r.github_repo,
    path: "AGENTS.md",
    content: r.body,
    message,
  });
  await audit(
    pool, {
      actor: "supervisor",
      action: "config.instructions_commit",
      target: "AGENTS.md",
      projectId,
      outcome: "error" in put ? "failed" : "allowed",
      reason: "error" in put ? put.error : null,
      extra: { version: r.version },
    },
  );
  return "error" in put ? `, NOT committed: ${put.error}` : ", committed";
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

/**
 * Every config decision, through the one audit path.
 *
 * This used to write the audit row itself, in raw SQL, and it was named
 * `audit` - which is why it never delegated: the shared helper could not even be
 * imported into this file without colliding with it. Renaming it is what made
 * the delegation possible, and the shared helper is where the metadata shape,
 * the outcome vocabulary and the failure logging live.
 */
async function auditConfigChange(
  pool: pg.Pool,
  change: ConfigChange,
  outcome: "allowed" | "denied",
  extra: Record<string, unknown>,
): Promise<void> {
  await audit(
    pool, {
      actor: change.actor,
      action: "config.change",
      target: change.key,
      projectId: change.projectId,
      outcome,
      conversationId: change.conversationId ?? null,
      extra: { result: outcome, asked: change.causedByMessage ?? null, ...extra },
    },
  );
}
