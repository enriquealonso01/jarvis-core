export const ALWAYS_CONFIRM_ACTIONS = new Set([
  "repo.delete",
  "repo.make_public",
  "repo.transfer",
  "repo.archive_active",
  "db.destructive",
  "auth.disable",
  "audit.disable",
  "backup.disable",
  "isolation.weaken",
  "secrets.export",
  "spend.enable",
  "spend.increase",
  "data.bulk_delete",
  "authority.widen",
]);

export function isAlwaysConfirm(action: string): boolean {
  return ALWAYS_CONFIRM_ACTIONS.has(action);
}

export function inQuietHours(now = new Date(), timeZone = "America/New_York"): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 19 * 60 + 30 || mins < 8 * 60;
}

/**
 * A project slug becomes a filesystem path (/var/lib/jarvis/worktrees/<slug>)
 * and arrives from a model tool call or an API body, so it is validated before
 * it reaches mkdir. `../../etc` was previously a legal slug.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes("..");
}

/** Enum values the model may supply, each backed by a CHECK constraint. */
export const PROJECT_ENUMS = {
  project_type: ["personal", "professional"],
  confidentiality: ["normal", "confidential", "restricted"],
  production_status: ["non_production", "staging", "production"],
  default_queue_priority: ["critical", "high", "normal", "low", "background"],
} as const;

export function validEnum(field: keyof typeof PROJECT_ENUMS, value: string): boolean {
  return (PROJECT_ENUMS[field] as readonly string[]).includes(value);
}

/**
 * What kind of account a profile is, derived from what is recorded about it
 * rather than from a list of names.
 *
 * S26: "Create a professional project → paid/subscription profiles only, and a
 * free consumer endpoint is refused for its source code." That needs a rule for
 * which is which, and the two facts already stored are enough:
 *
 * - `subscription_login` means Enrique is signed in to something he pays for —
 *   Claude Code, Codex, Cursor. A subscription.
 * - `metered_spend_allowed` means a billed API key with a ceiling behind it.
 * - Anything else is an API key on a free consumer tier. That is the default,
 *   and it is the safe default: a free tier is exactly the kind of endpoint
 *   whose terms permit training on what you send it.
 *
 * Deriving this rather than hardcoding provider names matters because the same
 * provider sells both — a free Gemini key and a paid one differ in the billing,
 * not in the hostname.
 */
export type ProfileTier = "subscription" | "metered" | "free_consumer";

export function profileTier(p: { auth_type: string; metered_spend_allowed: boolean }): ProfileTier {
  if (p.auth_type === "subscription_login") return "subscription";
  if (p.metered_spend_allowed) return "metered";
  return "free_consumer";
}

/**
 * Profiles that are not credentials for doing work: storage, telephony, speech,
 * the deploy broker. A professional project naming one of these is not asking
 * for a free model, so the tier rule does not apply to them.
 */
export const NON_MODEL_PROFILES = new Set([
  "backup_b2", "telnyx", "elevenlabs", "netcup_scp", "github_personal_admin", "composio",
]);

/** TEMPLATES.md: a professional project must answer these before it is created. */
export const PROFESSIONAL_REQUIRED = [
  "confidentiality",
  "production_status",
  "customer_facing",
  "metered_spend_allowed",
] as const;

export const ONBOARDING_FIELDS = [
  "name",
  "slug",
  "project_type",
  "confidentiality",
  "production_status",
  "customer_facing",
  "metered_spend_allowed",
  "spend_ceiling_cents",
  "allowed_auth_profiles",
  "github_owner",
  "github_repo",
  "default_branch",
  "default_queue_priority",
  "deploy_policy",
  "required_tests",
  // S26: the rest of what AGENTS.md needs. Every one of these fills a named
  // placeholder in the template, so a project cannot be finalized with a hole
  // in the instructions its own engineering tasks will read.
  "approved_data_processors",
  "setup_command",
  "test_command",
  "lint_command",
  "safe_environments",
  "project_forbidden",
  "before_pr",
  "before_deploy",
  "migration_policy",
] as const;

export function isBooleanish(value: string): boolean {
  return ["true", "false", "yes", "no"].includes(value.trim().toLowerCase());
}

export function toBoolean(value: string | undefined): boolean {
  return ["true", "yes"].includes((value ?? "").trim().toLowerCase());
}
