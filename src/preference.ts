/**
 * Preferences that can be changed, and changed back (plan S30).
 *
 * The plan asks for four behaviours, and three of them are about what happens
 * to the OLD statement:
 *
 *  - state a preference, contradict it, then ask - the current one answers;
 *  - Jarvis says so at the moment of the replacement, not silently;
 *  - the old one is still visible in the audit;
 *  - *"forget what I told you about X"* - not retrieved afterwards, still
 *    present as a superseded record.
 *
 * And one that is about restraint: **a passing remark that merely resembles a
 * preference does not overwrite one.** That is the hard half. A system eager to
 * learn will treat "the last PR was a bit long" as an instruction about PR
 * length and quietly replace a rule he actually stated. The cost is asymmetric:
 * failing to record a real preference is a small annoyance he can repeat,
 * while overwriting one with a remark is a rule that changes without anyone
 * deciding to change it.
 *
 * So a statement only replaces an existing preference when it is phrased as a
 * standing instruction. Everything else is stored as a note and never
 * supersedes anything.
 */
import type pg from "pg";

/**
 * Phrasings that make something a standing instruction rather than a remark.
 *
 * Deliberately narrow, and deliberately about FORM rather than topic: the
 * question is whether he is laying down a rule, not what the rule is about.
 */
const STANDING = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bI prefer\b/i,
  /\bI want\b.*\b(always|every|all)\b/i,
  /\bmake sure\b/i,
  /\bdefault to\b/i,
  /\bstop\b.*\bing\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
];

/** A remark, however preference-shaped, is not an instruction. */
export function isStandingInstruction(text: string): boolean {
  return STANDING.some((re) => re.test(text));
}

/** "forget what I told you about X" and its neighbours. */
const FORGET = [
  /\bforget what I (told|said)\b/i,
  /\bforget that\b/i,
  /\bignore what I (told|said)\b/i,
  /\bdisregard what I (told|said)\b/i,
];

export function isForgetRequest(text: string): boolean {
  return FORGET.some((re) => re.test(text));
}

export type PreferenceOutcome =
  | { action: "stored"; id: string; replaced: string[]; note: string }
  | { action: "noted"; id: string; note: string }
  | { action: "forgotten"; forgot: string[]; note: string }
  | { action: "nothing"; note: string };

/**
 * What the existing live memories are about, roughly.
 *
 * Overlap is measured on content words, because two statements about the same
 * subject share nouns even when they say opposite things - which is exactly the
 * pair we need to catch. A contradiction is not lexically different from an
 * agreement, so this deliberately does not try to detect disagreement: any
 * standing instruction on the same subject replaces the previous one, and the
 * old text stays readable in the audit so a person can see what changed.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "i", "you", "it", "is", "are", "be", "do", "not", "no", "my", "me", "we",
  "always", "never", "from", "now", "prefer", "want", "make", "sure", "please",
  "should", "would", "like", "them", "they", "that", "this", "when",
]);

export function subjectWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function sameSubject(a: string, b: string, minOverlap = 2): boolean {
  const wa = subjectWords(a);
  const wb = subjectWords(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared >= Math.min(minOverlap, Math.min(wa.size, wb.size));
}

/**
 * Record what he said, replacing an earlier instruction only when he gave one.
 *
 * Returns what happened and a sentence to say back. The sentence matters: the
 * plan asks that Jarvis says so AT THE MOMENT of the replacement, because a
 * preference that changes silently is one he cannot correct.
 */
export async function recordStatement(
  pool: pg.Pool,
  args: { projectId: string | null; text: string; inboxId?: string | null },
): Promise<PreferenceOutcome> {
  const text = args.text.trim();
  if (!text) return { action: "nothing", note: "nothing to record" };

  const live = await pool.query<{ id: string; body: string }>(
    `SELECT id::text, body FROM memory_items
      WHERE superseded_at IS NULL
        AND ($1::uuid IS NULL AND project_id IS NULL OR project_id = $1)
      ORDER BY created_at DESC LIMIT 200`,
    [args.projectId],
  );

  if (isForgetRequest(text)) {
    const targets = live.rows.filter((m) => sameSubject(m.body, text));
    if (!targets.length) {
      return { action: "nothing", note: "there was nothing recorded about that" };
    }
    for (const t of targets) {
      await pool.query(
        `UPDATE memory_items
            SET superseded_at = now(), superseded_reason = 'forgotten'
          WHERE id = $1`, [t.id]);
    }
    return {
      action: "forgotten",
      forgot: targets.map((t) => t.id),
      note: `Dropped ${targets.length === 1 ? "what you told me" : `${targets.length} things you told me`}`
        + ` about that. It stays in the record as withdrawn.`,
    };
  }

  const standing = isStandingInstruction(text);
  const stored = await pool.query<{ id: string }>(
    `INSERT INTO memory_items (project_id, kind, body, source_inbox_id)
     VALUES ($1, $2, $3, $4) RETURNING id::text`,
    [args.projectId, standing ? "preference" : "note", text, args.inboxId ?? null],
  );
  const id = stored.rows[0].id;

  if (!standing) {
    /*
     * The restraint half. A remark is kept - it may be useful - but it replaces
     * nothing, because overwriting a stated rule with an offhand comment changes
     * behaviour that nobody decided to change.
     */
    return { action: "noted", id, note: "Noted." };
  }

  const replaced = live.rows.filter((m) => sameSubject(m.body, text));
  for (const r of replaced) {
    await pool.query(
      `UPDATE memory_items
          SET superseded_at = now(), superseded_by = $2, superseded_reason = 'replaced'
        WHERE id = $1`, [r.id, id]);
  }

  return {
    action: "stored",
    id,
    replaced: replaced.map((r) => r.id),
    note: replaced.length
      ? `Noted, and that replaces what you told me before: "${replaced[0].body.slice(0, 80)}"`
      : "Noted.",
  };
}
