import type pg from "pg";
import { inQuietHours } from "./policy.js";
import { audit } from "./audit.js";

/**
 * Jarvis calls Enrique (plan S23).
 *
 * The phone rings for six reasons and no others. That list is the feature — a
 * dialler that rings for anything else is not a more helpful assistant, it is
 * one that gets silenced permanently, and then none of the six work either.
 *
 * "The commonest failure will be calling too often." So every decision is
 * written down, including the ones that decide NOT to ring: a table of placed
 * calls answers "did it ring", and only a table of wanted calls answers "how
 * often did it want to".
 */

export const CALL_REASONS = {
  /** 1. A task blocked over an hour on something only Enrique can unblock. */
  blocked_task: { label: "a task is blocked on you", override: false },
  /** 2. A production incident on a professional project. */
  production_incident: { label: "a production incident", override: false },
  /** 3. A destructive action awaiting approval past its window. */
  approval_overdue: { label: "an approval is overdue", override: false },
  /** 4. A security or isolation event. */
  security_event: { label: "a security event", override: true },
  /** 5. A call he scheduled. */
  scheduled: { label: "a call you asked for", override: false },
  /** 6. A monitoring rule he explicitly authorised to call. Per rule, opt-in. */
  monitor: { label: "a monitor you told me to call about", override: false },
} as const;

export type CallReason = keyof typeof CALL_REASONS;

/**
 * The one override, and it is narrow.
 *
 * "A confirmed security incident or active data loss may ring inside quiet
 * hours. Nothing else may — not a production outage, not a blocked task, not an
 * approval." Short enough to read aloud, which is the test of whether an
 * exception list has stayed honest.
 */
export const QUIET_HOURS_OVERRIDE: CallReason[] = ["security_event"];

export type DialVerdict =
  | { ring: true; reason: CallReason; why: string }
  | { ring: false; reason: CallReason; why: string; retryAfter: Date | null };

/** 08:00 the next morning, in Enrique's timezone, from any instant. */
export function nextMorning(now: Date, timeZone = "America/New_York"): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const next = new Date(now);
  // Before 08:00 it is this morning; after 19:30 it is tomorrow's.
  next.setUTCMinutes(next.getUTCMinutes() + (hour < 8 ? 0 : 24 * 60));
  const offsetProbe = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(next);
  const h = Number(offsetProbe.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(offsetProbe.find((p) => p.type === "minute")?.value ?? 0);
  // Walk it back to exactly 08:00 local.
  next.setUTCMinutes(next.getUTCMinutes() - (h * 60 + m) + 8 * 60);
  return next;
}

/**
 * May the phone ring, right now, for this reason?
 *
 * Enforced HERE, at the dial site, not in the UI — the plan is explicit, and a
 * check that lives in a form is a check that a background job walks past.
 */
export function mayDial(reason: CallReason, now = new Date()): DialVerdict {
  if (!(reason in CALL_REASONS)) {
    return { ring: false, reason, why: `${reason} is not one of the six reasons`, retryAfter: null };
  }
  if (!inQuietHours(now)) {
    return { ring: true, reason, why: "outside quiet hours" };
  }
  if (QUIET_HOURS_OVERRIDE.includes(reason)) {
    return { ring: true, reason, why: "a security event may ring inside quiet hours" };
  }
  return {
    ring: false,
    reason,
    why: "quiet hours, 19:30 to 08:00",
    retryAfter: nextMorning(now),
  };
}

/** The first sentence: who is calling, and why, before anything else. */
export function openingLine(reason: CallReason, subject: string): string {
  const said = subject.trim().replace(/\s+/g, " ");
  return `This is Jarvis, calling about ${CALL_REASONS[reason].label}. ${said}`;
}

/**
 * Record that a call is wanted, and decide whether it rings.
 *
 * Returns the row either way. A blocked call is not a dropped call: it becomes
 * a WhatsApp and an Issue, and comes back at 08:00.
 */
export async function wantCall(
  pool: pg.Pool,
  args: {
    reason: CallReason;
    subject: string;
    issueId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    scheduleId?: string | null;
    now?: Date;
  },
): Promise<{ id: string; verdict: DialVerdict }> {
  const now = args.now ?? new Date();
  const verdict = mayDial(args.reason, now);

  const r = await pool.query<{ id: string }>(
    `INSERT INTO outbound_calls (reason, subject, issue_id, task_id, project_id, schedule_id,
                                 state, blocked_reason, retry_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      args.reason,
      args.subject.slice(0, 500),
      args.issueId ?? null,
      args.taskId ?? null,
      args.projectId ?? null,
      args.scheduleId ?? null,
      verdict.ring ? "wanted" : "blocked",
      verdict.ring ? null : verdict.why,
      verdict.ring ? null : verdict.retryAfter,
    ],
  );

  await audit(pool, {
    actor: "jarvis",
    action: "call.decide",
    target: args.reason,
    projectId: args.projectId ?? null,
    taskId: args.taskId ?? null,
    outcome: verdict.ring ? "allowed" : "denied",
    reason: verdict.why,
    extra: { subject: args.subject.slice(0, 200), call_id: r.rows[0].id },
  });

  return { id: r.rows[0].id, verdict };
}

/** Test seam, matching the rest of the phone path. */
const FAKE = process.env.JARVIS_TELNYX === "fake";
/** Every dial that would have gone out, when the line is faked. */
export const dialled: { to: string; from: string; subject: string; reason: string }[] = [];
export function clearDialled(): void {
  dialled.length = 0;
}

/**
 * Place the call.
 *
 * One attempt. "Never redial in a loop" is enforced by there being no retry
 * path here at all: a call that is not answered becomes a WhatsApp, and the
 * only thing that can make the phone ring again is a NEW reason.
 */
export async function placeCall(
  pool: pg.Pool,
  callId: string,
): Promise<{ placed: boolean; detail: string }> {
  const row = await pool.query<{
    reason: CallReason; subject: string; state: string; attempts: number;
  }>(
    "SELECT reason, subject, state, attempts FROM outbound_calls WHERE id = $1",
    [callId],
  );
  const call = row.rows[0];
  if (!call) return { placed: false, detail: "no such call" };
  if (call.attempts > 0) return { placed: false, detail: "already attempted; Jarvis does not redial" };
  if (!["wanted", "blocked"].includes(call.state)) {
    return { placed: false, detail: `call is ${call.state}` };
  }

  // A voice call is dialled on the Telnyx pair, NOT the WhatsApp pair. These
  // were the WhatsApp numbers, and `whatsapp.jarvis_e164` is blank, so every
  // real dial went out with an empty `from` and Telnyx answered
  // `422 10004 Missing required parameter /from`. WhatsApp's owner number is
  // kept as a fallback for `to` only — it is the same human either way — but
  // there is no fallback for `from`: a call must leave from a number Telnyx
  // knows we own.
  const { sitePin } = await import("./siteconfig.js");
  const to = sitePin((c) => c.telnyx?.to_e164) ?? sitePin((c) => c.whatsapp?.owner_e164) ?? "";
  const from = sitePin((c) => c.telnyx?.from_e164) ?? "";
  if (!to) return { placed: false, detail: "no telnyx to_e164 or whatsapp owner_e164 pinned in site.yaml" };
  if (!from) return { placed: false, detail: "no telnyx from_e164 pinned in site.yaml" };

  const opening = openingLine(call.reason, call.subject);

  if (FAKE) {
    dialled.push({ to, from, subject: opening, reason: call.reason });
    await pool.query(
      `UPDATE outbound_calls SET state = 'placed', placed_at = now(), attempts = attempts + 1,
              call_control_id = $2 WHERE id = $1`,
      [callId, `fake-out-${callId.slice(0, 8)}`],
    );
    return { placed: true, detail: `would ring ${to}` };
  }

  const { telnyxDial } = await import("./callcontrol.js");
  const result = await telnyxDial(pool, { to, from, callId });
  await pool.query(
    `UPDATE outbound_calls SET state = $2, placed_at = now(), attempts = attempts + 1,
            call_control_id = $3, blocked_reason = $4 WHERE id = $1`,
    [callId, result.ok ? "placed" : "failed", result.callControlId ?? null, result.ok ? null : result.detail],
  );
  return { placed: result.ok, detail: result.detail };
}

/**
 * The six reasons, looked for. Nothing else may ring the phone.
 *
 * Written as one function so the list is readable in one screen — the plan's
 * "and no others" is only checkable if the whole set is in one place. A routine
 * completion is conspicuously absent, and its absence is asserted by the test
 * rather than left to a reader.
 */
export async function reasonsToCall(
  pool: pg.Pool,
  now = new Date(),
): Promise<{ reason: CallReason; subject: string; taskId?: string; issueId?: string; projectId?: string | null; scheduleId?: string }[]> {
  const out: { reason: CallReason; subject: string; taskId?: string; issueId?: string; projectId?: string | null; scheduleId?: string }[] = [];

  // 1. A task blocked over an hour on something only Enrique can unblock.
  const blocked = await pool.query<{ id: string; title: string; project_id: string | null; waiting_reason: string | null }>(
    `SELECT t.id, t.title, t.project_id, t.waiting_reason
     FROM tasks t
     WHERE t.state = 'waiting_for_user'
       AND t.updated_at < $1::timestamptz - interval '1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM outbound_calls c WHERE c.task_id = t.id AND c.reason = 'blocked_task'
       )`,
    [now.toISOString()],
  );
  for (const t of blocked.rows) {
    out.push({
      reason: "blocked_task",
      subject: `${t.title} has been waiting on you for over an hour. ${t.waiting_reason ?? ""}`.trim(),
      taskId: t.id,
      projectId: t.project_id,
    });
  }

  // 2. A production incident on a professional project.
  const incidents = await pool.query<{ id: string; title: string; project_id: string | null }>(
    `SELECT i.id, i.title, i.project_id
     FROM issues i
     JOIN projects p ON p.id = i.project_id
     WHERE i.status NOT IN ('resolved','ignored')
       AND i.severity = 'critical'
       AND p.project_type = 'professional'
       AND NOT EXISTS (SELECT 1 FROM outbound_calls c WHERE c.issue_id = i.id)`,
  );
  for (const i of incidents.rows) {
    out.push({ reason: "production_incident", subject: i.title, issueId: i.id, projectId: i.project_id });
  }

  // 3. A destructive action awaiting approval past its window.
  const overdue = await pool.query<{ id: string; action_type: string; target: string | null; project_id: string | null }>(
    `SELECT a.id, a.action_type, a.target, a.project_id
     FROM approvals a
     WHERE a.state = 'pending' AND a.expires_at < $1::timestamptz
       AND a.requires_reauth = true
       AND NOT EXISTS (
         SELECT 1 FROM outbound_calls c
         WHERE c.reason = 'approval_overdue' AND c.subject LIKE '%' || a.id || '%'
       )`,
    [now.toISOString()],
  );
  for (const a of overdue.rows) {
    out.push({
      reason: "approval_overdue",
      subject: `${a.action_type} on ${a.target ?? "something"} is past its approval window (${a.id}).`,
      projectId: a.project_id,
    });
  }

  // 4. A security or isolation event.
  const security = await pool.query<{ id: string; title: string; project_id: string | null }>(
    `SELECT id, title, project_id FROM issues
     WHERE status NOT IN ('resolved','ignored')
       AND category IN ('security.isolation','security.broker_deny')
       AND severity IN ('critical','high')
       AND NOT EXISTS (SELECT 1 FROM outbound_calls c WHERE c.issue_id = issues.id)`,
  );
  for (const i of security.rows) {
    out.push({ reason: "security_event", subject: i.title, issueId: i.id, projectId: i.project_id });
  }

  // 5. A call he scheduled.
  /*
   * Matched by cron, the same way every other schedule fires — schedules have no
   * `next_run_at` column, they are matched minute by minute. The dedupe is on
   * the MINUTE, which is what makes "does not ring twice after a restart" true:
   * a worker that comes back up inside the same minute finds the row it already
   * wrote and does not write another.
   */
  const { cronMatches } = await import("./cron.js");
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  const callSchedules = await pool.query<{
    id: string; name: string; call_subject: string | null; project_id: string | null;
    cron: string; timezone: string;
  }>(
    `SELECT id, name, call_subject, project_id, cron, timezone
     FROM schedules WHERE action = 'call' AND paused = false`,
  ).catch(() => ({ rows: [] as {
    id: string; name: string; call_subject: string | null; project_id: string | null;
    cron: string; timezone: string;
  }[] }));

  for (const sch of callSchedules.rows) {
    if (!cronMatches(sch.cron, minute, sch.timezone || "America/New_York")) continue;
    const already = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbound_calls
       WHERE schedule_id = $1 AND date_trunc('minute', wanted_at) = $2::timestamptz`,
      [sch.id, minute.toISOString()],
    );
    if (Number(already.rows[0].n) > 0) continue;
    out.push({
      reason: "scheduled",
      subject: sch.call_subject ?? sch.name,
      scheduleId: sch.id,
      projectId: sch.project_id,
    });
  }

  // 6. A monitoring rule he explicitly authorised to call. Opt-in, per rule.
  const monitors = await pool.query<{ id: string; title: string; project_id: string | null }>(
    `SELECT id, title, project_id FROM issues
     WHERE status NOT IN ('resolved','ignored')
       AND COALESCE(evidence->>'may_call', 'false') = 'true'
       AND NOT EXISTS (SELECT 1 FROM outbound_calls c WHERE c.issue_id = issues.id)`,
  );
  for (const i of monitors.rows) {
    out.push({ reason: "monitor", subject: i.title, issueId: i.id, projectId: i.project_id });
  }

  return out;
}

/**
 * The sweep: decide, ring, and fall back — once each.
 */
export async function sweepOutboundCalls(pool: pg.Pool, now = new Date()): Promise<string[]> {
  const done: string[] = [];

  for (const want of await reasonsToCall(pool, now)) {
    const { id, verdict } = await wantCall(pool, { ...want, now });
    if (!verdict.ring) {
      await fallBackToWhatsApp(pool, id, verdict.why);
      done.push(`${want.reason}: not now — ${verdict.why}`);
      continue;
    }
    const placed = await placeCall(pool, id);
    done.push(`${want.reason}: ${placed.detail}`);
  }

  // Calls quiet hours pushed to the morning.
  const due = await pool.query<{ id: string; reason: CallReason }>(
    `SELECT id, reason FROM outbound_calls
     WHERE state = 'blocked' AND retry_after IS NOT NULL AND retry_after <= $1::timestamptz
       AND attempts = 0`,
    [now.toISOString()],
  );
  for (const row of due.rows) {
    const verdict = mayDial(row.reason, now);
    if (!verdict.ring) continue;
    await pool.query("UPDATE outbound_calls SET state = 'wanted', blocked_reason = NULL WHERE id = $1", [row.id]);
    const placed = await placeCall(pool, row.id);
    done.push(`${row.reason}: retried at 08:00 — ${placed.detail}`);
  }

  return done;
}

/**
 * A call that could not ring, or was not answered, still has to arrive.
 *
 * The plan: a blocked call "becomes a WhatsApp plus an Issue and retries at
 * 08:00"; a declined one gets "one WhatsApp, no redial loop". Same fallback,
 * different trigger, and neither of them silently drops what it was about.
 */
export async function fallBackToWhatsApp(
  pool: pg.Pool,
  callId: string,
  why: string,
): Promise<void> {
  const row = await pool.query<{ reason: CallReason; subject: string; project_id: string | null }>(
    "SELECT reason, subject, project_id FROM outbound_calls WHERE id = $1",
    [callId],
  );
  const call = row.rows[0];
  if (!call) return;

  const { enqueueNotification, raiseIssue } = await import("./notify.js");
  await enqueueNotification(pool, {
    level: "whatsapp_blocker",
    messageType: "call_fallback",
    body: `${openingLine(call.reason, call.subject)} (${why})`,
    objectType: "outbound_call",
    objectId: callId,
    idempotencyKey: `call.fallback:${callId}`,
  });
  await raiseIssue(pool, {
    category: "config.missing",
    service: "phone",
    owner: "user",
    status: "waiting_for_user",
    title: `[call] ${CALL_REASONS[call.reason].label} — ${why}`,
    dedupeKey: `call.fallback:${callId}`,
    projectId: call.project_id,
    evidence: { call_id: callId, reason: call.reason, subject: call.subject },
    requiredAction: call.subject,
    notifyOverride: "ui_only",
  });
  await audit(pool, {
    actor: "jarvis",
    action: "call.fallback",
    target: call.reason,
    projectId: call.project_id,
    outcome: "failed",
    reason: why,
    extra: { call_id: callId },
  });
}
