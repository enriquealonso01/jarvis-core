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
] as const;

export function isBooleanish(value: string): boolean {
  return ["true", "false", "yes", "no"].includes(value.trim().toLowerCase());
}

export function toBoolean(value: string | undefined): boolean {
  return ["true", "yes"].includes((value ?? "").trim().toLowerCase());
}
