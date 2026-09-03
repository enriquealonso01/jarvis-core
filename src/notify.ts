import crypto from "node:crypto";
import type pg from "pg";
import { inQuietHours } from "./policy.js";
import { sseBroadcast } from "./sse.js";

/**
 * ERROR_TAXONOMY.md as code. The `notify` column was documented but nothing
 * implemented it, so every Issue was equally silent: the outbox was drained by
 * the worker and never written to by anything.
 */
export type NotifyLevel = "none" | "ui_only" | "whatsapp_degraded" | "whatsapp_blocker";

export type ErrorClass = {
  severity: "critical" | "high" | "medium" | "low";
  /** false means a retry cannot help; the fix is elsewhere. */
  retryable: boolean;
  limit: number | null;
  notify: NotifyLevel;
};

export const ERROR_CLASSES: Record<string, ErrorClass> = {
  "model.rate_limit": { severity: "medium", retryable: true, limit: 5, notify: "ui_only" },
  "model.outage": { severity: "high", retryable: true, limit: 5, notify: "whatsapp_degraded" },
  "model.removed": { severity: "high", retryable: false, limit: null, notify: "whatsapp_degraded" },
  "provider.degraded": { severity: "high", retryable: true, limit: 5, notify: "whatsapp_degraded" },
  "provider.cred_expired": { severity: "high", retryable: false, limit: null, notify: "whatsapp_blocker" },
  // A model ID the provider no longer serves. Unlike a quota window this never
  // recovers on its own — the route has to be re-pinned by a person — so it is
  // not retryable and it pages as a blocker.
  "provider.model_retired": { severity: "medium", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "oauth.expired": { severity: "high", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "mcp.crash": { severity: "medium", retryable: true, limit: 3, notify: "ui_only" },
  "browser.crash": { severity: "medium", retryable: true, limit: 3, notify: "ui_only" },
  "harness.crash": { severity: "high", retryable: true, limit: 3, notify: "ui_only" },
  "worker.crash": { severity: "high", retryable: true, limit: 3, notify: "ui_only" },
  "network.timeout": { severity: "medium", retryable: true, limit: 5, notify: "none" },
  "webhook.duplicate": { severity: "low", retryable: false, limit: null, notify: "none" },
  "git.conflict": { severity: "medium", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "test.failure": { severity: "medium", retryable: false, limit: null, notify: "none" },
  "process.stuck": { severity: "high", retryable: true, limit: 3, notify: "ui_only" },
  "queue.restart": { severity: "medium", retryable: false, limit: null, notify: "none" },
  "resource.disk": { severity: "high", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "resource.ram": { severity: "high", retryable: false, limit: null, notify: "ui_only" },
  "resource.io": { severity: "medium", retryable: true, limit: 3, notify: "ui_only" },
  "db.error": { severity: "critical", retryable: true, limit: 5, notify: "whatsapp_blocker" },
  "artifact.corrupt": { severity: "medium", retryable: false, limit: null, notify: "ui_only" },
  "model.malformed_tool": { severity: "medium", retryable: true, limit: 3, notify: "none" },
  "agent.loop": { severity: "high", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "notification.delivery": { severity: "medium", retryable: true, limit: 8, notify: "ui_only" },
  "backup.failure": { severity: "critical", retryable: true, limit: 3, notify: "whatsapp_blocker" },
  "maintenance": { severity: "low", retryable: false, limit: null, notify: "ui_only" },
  "security.isolation": { severity: "critical", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "security.broker_deny": { severity: "high", retryable: false, limit: null, notify: "ui_only" },
  "security.retention_breach": { severity: "critical", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "config.drift": { severity: "medium", retryable: true, limit: 1, notify: "ui_only" },
  "schedule.repeat_fail": { severity: "medium", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "telnyx.quiet_hours": { severity: "low", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "setup.pending": { severity: "medium", retryable: false, limit: null, notify: "whatsapp_blocker" },
  "supervisor.fail": { severity: "high", retryable: true, limit: 5, notify: "whatsapp_degraded" },

  /*
   * The three classes that used to fall through to worker.crash (B10).
   *
   * They are in failures.ts's POLICY but were never given a row here, so
   * `classify` returned the worker.crash fallback for all three: high /
   * ui_only, silently. The fallback is right for a category nobody has
   * classified; these are not that - they are known members of the taxonomy,
   * and agent.repeat fires in production.
   *
   * `retryable` and `limit` are not choices: they are read off the retry policy
   * already recorded for each in failures.ts, so the two tables cannot disagree.
   *
   * TWO TRANSLATIONS were needed and are written down so they can be overruled.
   * Enrique's decision used "error" and "warning", which are not values this
   * enum has - mapped to `high` and `medium`. And "Issue + WhatsApp" for
   * agent.repeat became `whatsapp_degraded` rather than `whatsapp_blocker`,
   * because a blocker sends messageType "blocker" and puts the required action
   * in the body: it is the level for something he must act on. A repeating
   * agent parks the task as stalled and wants him to know, not to do.
   */
  "agent.repeat": { severity: "high", retryable: false, limit: null, notify: "whatsapp_degraded" },
  "dependency.unavailable": { severity: "medium", retryable: true, limit: 4, notify: "ui_only" },
  "resource.cpu": { severity: "medium", retryable: true, limit: 3, notify: "ui_only" },
};

/** Unknown errors are worker.crash severity: Issue, no data deleted. */
export function classify(category: string): ErrorClass {
  return ERROR_CLASSES[category] ?? ERROR_CLASSES["worker.crash"];
}

/** min(600, 2^attempt) seconds plus 0-20% jitter (ERROR_TAXONOMY.md). */
export function backoffSeconds(attempt: number): number {
  const base = Math.min(600, 2 ** Math.max(0, attempt));
  const jitter = base * (crypto.randomInt(0, 21) / 100);
  return Math.round(base + jitter);
}

/**
 * Queue an outbound message. Plan §17.5: everything goes through the outbox with
 * an idempotency key, so a retry cannot double-send and a delivery failure never
 * marks the underlying work as delivered.
 *
 * Returns null when policy says stay quiet — §17.1, trivial captures are silent.
 */
export async function enqueueNotification(
  pool: pg.Pool,
  args: {
    level: NotifyLevel;
    messageType: string;
    body: string;
    objectType?: string;
    objectId?: string;
    idempotencyKey: string;
    /**
     * The channel this notification is ABOUT, when it is about one.
     *
     * A message asking Enrique to pair WhatsApp was queued on WhatsApp, where
     * it waited for the pairing it was asking for. It had been failing since
     * 21:59 and was a large share of the delivery-retry traffic. The rule is
     * structural rather than a special case for one message: a notification
     * about a channel cannot be delivered by it, so that channel is removed
     * from its delivery set and the console - which is always live - carries it.
     */
    aboutChannel?: string;
  },
): Promise<string | null> {
  if (args.level === "none") return null;

  // ui_only never leaves the console. The higher levels also write a ui row so
  // the notification center shows the same thing the phone would.
  const all: string[] = args.level === "ui_only" ? ["ui"] : ["ui", "whatsapp"];
  const channels = all.filter((c) => c !== args.aboutChannel);

  let firstId: string | null = null;
  for (const channel of channels) {
    // Quiet hours hold outbound voice, not WhatsApp or the console (§18).
    const key = `${args.idempotencyKey}:${channel}`;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO notifications_outbox
         (channel, message_type, body, object_type, object_id, idempotency_key, state, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [channel, args.messageType, args.body, args.objectType ?? null, args.objectId ?? null, key],
    );
    if (r.rows[0] && !firstId) firstId = r.rows[0].id;
  }
  if (firstId) sseBroadcast("issue.updated", {});
  return firstId;
}

/**
 * The one way to raise an Issue. Dedupes on the class-level key, bumps the
 * occurrence count, and notifies at whatever level the taxonomy says for that
 * category — rather than every caller inventing both.
 */
export async function raiseIssue(
  pool: pg.Pool,
  args: {
    category: string;
    title: string;
    dedupeKey: string;
    service?: string;
    owner?: "jarvis" | "user" | "provider";
    status?: string;
    projectId?: string | null;
    taskId?: string | null;
    requiredAction?: string;
    evidence?: Record<string, unknown>;
    severityOverride?: "critical" | "high" | "medium" | "low";
    notifyOverride?: NotifyLevel;
  },
): Promise<{ issueId: string | null; created: boolean; notified: boolean }> {
  const cls = classify(args.category);
  const severity = args.severityOverride ?? cls.severity;
  const evidence = JSON.stringify(args.evidence ?? {});

  const updated = await pool.query<{ id: string }>(
    `UPDATE issues
     SET occurrences = occurrences + 1, last_seen_at = now(), updated_at = now(), evidence = $2::jsonb
     WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')
     RETURNING id`,
    [args.dedupeKey, evidence],
  );
  if (updated.rows[0]) {
    // Already open and already notified once; repetition is a count, not a page.
    return { issueId: updated.rows[0].id, created: false, notified: false };
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO issues (severity, category, service, status, owner, title, evidence,
                         required_action, dedupe_key, project_id, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING id`,
    [
      severity,
      args.category,
      args.service ?? args.category.split(".")[0],
      args.status ?? (args.owner === "user" ? "waiting_for_user" : "open"),
      args.owner ?? "jarvis",
      args.title,
      evidence,
      args.requiredAction ?? null,
      args.dedupeKey,
      args.projectId ?? null,
      args.taskId ?? null,
    ],
  );
  const issueId = inserted.rows[0].id;

  const level = args.notifyOverride ?? cls.notify;
  const notified = await enqueueNotification(pool, {
    level,
    messageType: level === "whatsapp_blocker" ? "blocker" : "status",
    body:
      level === "whatsapp_blocker"
        ? `${args.title}${args.requiredAction ? ` — ${args.requiredAction}` : ""}`
        : args.title,
    objectType: "issue",
    objectId: issueId,
    idempotencyKey: `issue:${args.dedupeKey}`,
  });

  sseBroadcast("issue.updated", { id: issueId });
  return { issueId, created: true, notified: notified !== null };
}

/**
 * §17.1/§17.2: trivial captures stay silent. Only work worth a sentence gets one.
 */
export async function notifyTaskComplete(
  pool: pg.Pool,
  args: { taskId: string; title: string; lane: string; summary: string; trivial: boolean },
): Promise<string | null> {
  if (args.trivial || args.lane === "system") return null;
  return enqueueNotification(pool, {
    level: "ui_only",
    messageType: "completion",
    body: `${args.title} — ${args.summary}`,
    objectType: "task",
    objectId: args.taskId,
    idempotencyKey: `task.complete:${args.taskId}`,
  });
}

export { inQuietHours };
