/**
 * The messages Jarvis starts (plan S33).
 *
 * §17 is entirely about REPLIES: he asked, Jarvis answers, and the policy is
 * length and timing. Nothing there governs the other kind - the message sent
 * when he did not ask for anything - and the plan is blunt about where that
 * leads:
 *
 *   "S23 gives the phone a closed list of six reasons to ring, and tests that
 *    ONLY those ring. WhatsApp has no such list, and it is the channel that
 *    actually reaches him. Meanwhile the sources of unprompted messages keep
 *    accumulating: weekly findings, a proposed capability, an auth handoff, an
 *    approval, a maintenance issue, a queued desktop action. Each one is
 *    defensible on its own, and together they turn the pager into a feed."
 *
 * So this is S23's shape applied to the channel that had none: a closed list,
 * enforced at the send site, with everything else refused.
 *
 * THE OVERRIDE IS S23'S OBJECT, IMPORTED, NOT A SECOND ONE. The plan says why
 * in a sentence worth keeping: "two override lists diverge and the looser one
 * wins." So an unprompted reason does not carry its own override flag; it
 * declares which of S23's six it corresponds to, and it overrides quiet hours
 * exactly when that one does. Adding a WhatsApp reason that rings through the
 * night is therefore not something a caller can do here - it requires editing
 * the list the phone reads.
 */
import type pg from "pg";
import { inQuietHours } from "./policy.js";
import { nextMorning, QUIET_HOURS_OVERRIDE, type CallReason } from "./outbound.js";

/**
 * Every reason Jarvis may open a conversation. There are no others.
 *
 * `escalatesAs` is the S23 reason this corresponds to, and it is what decides
 * quiet-hours behaviour. Most are null: they are worth a message and are not
 * worth waking him.
 */
export const UNPROMPTED_REASONS = {
  /** A task is blocked on something only he can do (§17: one message, with a link). */
  blocker: { label: "a task is blocked on you", escalatesAs: null },
  /** An action needs his approval before it can proceed (S42). */
  approval: { label: "something needs your approval", escalatesAs: null },
  /** A site or provider needs him to sign in (S46). */
  auth_handoff: { label: "a sign-in needs you", escalatesAs: null },
  /** Maintenance found something it cannot fix itself. */
  maintenance: { label: "maintenance needs a decision", escalatesAs: null },
  /** Improvement proposes a capability it could build (S44). */
  proposal: { label: "a suggestion", escalatesAs: null },
  /** An action queued for his workstation is waiting (S47). */
  desktop_queued: { label: "something is waiting on your desktop", escalatesAs: null },
  /** The weekly report. S38 renders it as a document plus two lines. */
  weekly_report: { label: "your weekly report", escalatesAs: null },
  /**
   * A confirmed security incident or active data loss.
   *
   * The only one that maps onto an S23 reason with the override, which is what
   * lets it through quiet hours - and it is the same narrow exception the phone
   * uses rather than a second one that would drift.
   */
  security_event: { label: "a security event", escalatesAs: "security_event" as CallReason },
} as const;

export type UnpromptedReason = keyof typeof UNPROMPTED_REASONS;

/** The window inside which several items become one message. */
export const BATCH_WINDOW_MS = 15 * 60 * 1000;

export type SendVerdict =
  | { send: true; why: string }
  | { send: false; held: true; sendAfter: Date; why: string }
  | { send: false; held: false; why: string };

/**
 * May Jarvis open a conversation about this, now?
 *
 * Enforced here rather than at each caller, for the reason S23 gives about the
 * dial site: a check that lives in the feature that wants to send is a check
 * the next feature does not know about.
 */
export function mayOpenConversation(reason: string, now = new Date()): SendVerdict {
  // `in` walks the prototype chain, so `__proto__`, `constructor`, `toString`
  // and every other inherited key satisfied this check and passed a list whose
  // whole purpose is that everything else is refused. Observed on the box: the
  // phone would have rung for `__proto__`. `Object.hasOwn` asks the question
  // that was meant - is this one of OURS - rather than the one `in` answers.
  if (!Object.hasOwn(UNPROMPTED_REASONS, reason)) {
    /*
     * The assertion the plan says matters most is the ABSENCE - "a test that
     * only proves the six work would pass on a system that also sends nine
     * others" - so an unlisted reason is refused here rather than being allowed
     * through by a default that treats the list as advisory.
     */
    return { send: false, held: false, why: `${reason} is not a reason Jarvis may start a conversation about` };
  }
  const r = UNPROMPTED_REASONS[reason as UnpromptedReason];
  if (!inQuietHours(now)) return { send: true, why: "outside quiet hours" };
  if (r.escalatesAs && QUIET_HOURS_OVERRIDE.includes(r.escalatesAs)) {
    return { send: true, why: "a security event may reach him inside quiet hours" };
  }
  /*
   * Held, not dropped. S23 blocks a CALL inside quiet hours and the call
   * "becomes a WhatsApp" - which is how the rule that stops the phone ringing
   * at 03:00 routes the interruption to the same phone by a different route. It
   * buzzes instead of ringing, "which is not what quiet hours means to the
   * person asleep next to it."
   */
  return {
    send: false, held: true, sendAfter: nextMorning(now),
    why: "quiet hours, 19:30 to 08:00 — held until the morning",
  };
}

/**
 * Replies are not affected, ever.
 *
 * "If he messages at 02:00, Jarvis answers at 02:00. Quiet hours govern what
 * Jarvis starts, never what he starts."
 *
 * A function rather than a comment, so the rule is something a test can hold
 * and a future quiet-hours change has to walk past deliberately.
 */
export function mayReply(_now = new Date()): { send: true; why: string } {
  /*
   * The parameter is accepted and ignored, and both halves are deliberate.
   *
   * Ignored, because the answer does not depend on the hour - that IS the rule.
   * Accepted, because a rule about 02:00 has to be testable AT 02:00: with no
   * clock in the signature the suite can only ask at whatever time it happens
   * to run, and a version that started consulting quiet hours would pass every
   * afternoon. Found exactly that way - the sabotage that made replies obey
   * quiet hours went green because the suite ran at 14:00.
   */
  return { send: true, why: "he started this conversation, and quiet hours govern only what Jarvis starts" };
}

export type Queued = {
  id: string | null;
  verdict: SendVerdict;
};

/**
 * Record that a message is wanted, and decide whether it may go now.
 *
 * The row is written even when the answer is no, including for a reason that is
 * not on the list: a caller that ignores the return value would otherwise make
 * a refusal invisible, and "how often did something want to message him" is the
 * question that catches a feed forming.
 */
export async function queueUnprompted(
  pool: pg.Pool,
  args: {
    reason: string; subject: string; link?: string | null;
    projectId?: string | null; now?: Date;
  },
): Promise<Queued> {
  const now = args.now ?? new Date();
  const verdict = mayOpenConversation(args.reason, now);
  const sendAfter = verdict.send ? now : ("sendAfter" in verdict ? verdict.sendAfter : now);
  const refused = !verdict.send && !("sendAfter" in verdict) ? verdict.why : null;

  const r = await pool.query<{ id: string }>(
    `INSERT INTO unprompted_messages (reason, subject, link, project_id, wanted_at, send_after, refused_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [args.reason, args.subject, args.link ?? null, args.projectId ?? null, now, sendAfter, refused],
  );
  return { id: r.rows[0].id, verdict };
}

export type Batch = {
  batchId: string;
  lines: string[];
  ids: string[];
};

/**
 * Everything due, as ONE message.
 *
 * "Three findings at 09:00 are one message with three lines, not three
 * notifications — the same principle as the repeated-condition counter, applied
 * across kinds instead of within one."
 *
 * Returns null when nothing is due, so a caller cannot accidentally send an
 * empty message on a quiet morning.
 */
export async function drainUnprompted(
  pool: pg.Pool,
  now = new Date(),
): Promise<Batch | null> {
  const due = await pool.query<{ id: string; reason: string; subject: string; link: string | null }>(
    `SELECT id, reason, subject, link FROM unprompted_messages
      WHERE sent_at IS NULL AND refused_reason IS NULL AND send_after <= $1
      ORDER BY wanted_at`,
    [now],
  );
  if (!due.rows.length) return null;

  const batchId = (await pool.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  const ids = due.rows.map((r) => r.id);
  await pool.query(
    `UPDATE unprompted_messages SET sent_at = $2, batch_id = $3 WHERE id = ANY($1::uuid[])`,
    [ids, now, batchId]);

  const lines = due.rows.map((r) => {
    const label = UNPROMPTED_REASONS[r.reason as UnpromptedReason]?.label ?? r.reason;
    // The link is on the line it belongs to. A message with three items and one
    // link at the bottom sends him to the wrong page two times in three.
    return r.link ? `${label}: ${r.subject} — ${r.link}` : `${label}: ${r.subject}`;
  });
  return { batchId, lines, ids };
}
