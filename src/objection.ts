/**
 * Saying something once, and then doing it anyway (plan S42).
 *
 * Everything else in S42 is about AUTHORITY — whether Jarvis is allowed. This is
 * the part that is not:
 *
 *   "*Skip the tests and push it.* *Drop the retention to a day.* *Delete that
 *    project.* On a personal project none of those touch a gate, so they proceed
 *    in silence — and **a system that only ever objects on rules will quietly do
 *    the harmful-but-authorised thing every time. A good engineer says something
 *    once.**"
 *
 * FOUR RULES, AND THREE OF THEM ARE ABOUT NOT DOING TOO MUCH.
 *
 * ONE: **it does not block.** "The objection travels with the work starting,
 * never as a question that waits for an answer. An objection that stalls the task
 * is a refusal wearing softer words." So `proceed` is typed as the literal
 * `true`. A version of this that could block has to change the type, which means
 * changing every caller, rather than adding an early return somebody reviews in
 * isolation.
 *
 * TWO: **it never becomes a refusal.** "If the action genuinely is not allowed,
 * that is the gate's job and the gate says so. Mixing the two means he cannot
 * tell whether Jarvis is asking or blocking, which costs more than either." This
 * file therefore has no concept of denial at all — not a denied branch that is
 * never taken, none.
 *
 * THREE: **once.** "Repeating an objection is how an assistant becomes something
 * he routes around, and the second time is always more annoying than the first
 * was useful." Enforced by a unique index rather than by a SELECT-then-INSERT,
 * because two requests arriving together would both find nothing and both speak.
 *
 * FOUR: **the bar is real and taste is not on it.** "The bar is data loss,
 * irreversibility, or a rule he set himself. *'You asked me to always run the
 * suite on this project'* is worth a sentence. *'I would have structured it
 * differently'* is not — taste is not an objection, and a Jarvis that
 * editorialises is one he stops reading." So the grounds are a closed set, and
 * anything not on it produces silence rather than a softer sentence.
 */
import crypto from "node:crypto";
import type pg from "pg";

/**
 * The only three things worth a sentence.
 *
 * An allow-list, so a new kind of misgiving is silent until somebody decides it
 * belongs here. The failure this shape prevents is the gradual one: a
 * `severity: "minor"` value appears, then everything becomes minor-worthy, and
 * he stops reading.
 */
export const GROUNDS = ["data_loss", "irreversible", "his_own_rule"] as const;
export type Ground = (typeof GROUNDS)[number];

export function isGround(value: string): value is Ground {
  return (GROUNDS as readonly string[]).includes(value);
}

/**
 * What comes back when there is something to say.
 *
 * `proceed` is the literal `true`, not `boolean`. See rule one: this is the
 * difference between a type that cannot express a block and a type that happens
 * not to be blocking today.
 */
export type Objection = {
  sentence: string;
  proceed: true;
  ground: Ground;
};

/** Long enough for a reason, short enough that it is one sentence. */
export const MAX_OBJECTION_CHARS = 200;

/**
 * Identity of an objection: the practice, not the occasion.
 *
 * Keyed on project, action and ground rather than on the task, because "he asked
 * again" means the same request on the same work — and a per-task key would let
 * the same sentence arrive on every task forever, which is the thing being
 * prevented.
 */
export function objectionFingerprint(args: {
  projectId: string | null;
  action: string;
  ground: Ground;
}): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([args.projectId ?? "global", args.action, args.ground]))
    .digest("hex");
}

/** The sentence itself. One, and about consequence rather than preference. */
export function objectionSentence(args: {
  ground: Ground;
  what: string;
  /** For his_own_rule: the rule, in his words. */
  rule?: string | null;
}): string {
  const body = args.ground === "his_own_rule"
    ? `You asked me to ${args.rule ?? "do this differently"} on this project, and ${args.what} skips that`
    : args.ground === "data_loss"
      ? `${capitalise(args.what)} loses data that is not recoverable afterwards`
      : `${capitalise(args.what)} cannot be undone once it has run`;
  const tail = " — doing it now.";
  const sentence = `${body}${tail}`;
  if (sentence.length <= MAX_OBJECTION_CHARS) return sentence;
  /*
   * The tail's length is measured rather than guessed. The first version
   * reserved fifteen characters for a seventeen-character tail, so the
   * truncated form came out two over the cap it exists to enforce - which the
   * suite caught, and which is the whole reason the cap is asserted rather than
   * intended.
   */
  const ellipsis = "…";
  const room = MAX_OBJECTION_CHARS - tail.length - ellipsis.length;
  return `${body.slice(0, room).trimEnd()}${ellipsis}${tail}`;
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Say it, if it has not been said.
 *
 * Returns null for silence, and silence is the common case: no ground, or one
 * already spoken. The INSERT is what decides — `ON CONFLICT DO NOTHING` with no
 * row returned means somebody already said this, including a concurrent caller
 * a SELECT would have missed.
 *
 * Note what this function cannot do. It returns an objection or nothing; there
 * is no third value and no thrown denial. Whether the work is ALLOWED was
 * settled before this was called, by `impact.ts` and `checkGrant`, and mixing
 * the two is the failure the plan names.
 */
export async function objectOnce(
  pool: pg.Pool,
  args: {
    projectId: string | null;
    action: string;
    /** What he asked for, in his terms, for the sentence. */
    what: string;
    ground: string;
    rule?: string | null;
    taskId?: string | null;
    now?: Date;
  },
): Promise<Objection | null> {
  /*
   * Taste is not an objection. An unrecognised ground is silence rather than a
   * softer sentence - "a Jarvis that editorialises is one he stops reading".
   */
  if (!isGround(args.ground)) return null;

  const fingerprint = objectionFingerprint({
    projectId: args.projectId, action: args.action, ground: args.ground,
  });
  const sentence = objectionSentence({ ground: args.ground, what: args.what, rule: args.rule });

  const r = await pool.query<{ id: string }>(
    `INSERT INTO objections (fingerprint, project_id, action, ground, sentence, said_at, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (fingerprint) DO NOTHING
     RETURNING id`,
    [
      fingerprint, args.projectId, args.action, args.ground, sentence,
      args.now ?? new Date(), args.taskId ?? null,
    ],
  );

  // Already said. The work still happens; it just happens quietly.
  if (!r.rows[0]) return null;

  return { sentence, proceed: true, ground: args.ground };
}

/**
 * Were they right?
 *
 * "A Jarvis that objects and is usually wrong should object less, and that is
 * measurable rather than a matter of tone." Nothing calls this yet — S48 is where
 * the judgement comes from — but the column and the reader exist so that S48 has
 * something to read rather than a schema change to make first.
 */
export async function judgeObjection(
  pool: pg.Pool,
  fingerprint: string,
  wasRight: boolean,
): Promise<void> {
  await pool.query(`UPDATE objections SET was_right = $2 WHERE fingerprint = $1`,
    [fingerprint, wasRight]);
}

/**
 * How often objecting has turned out to be right.
 *
 * Unjudged objections are EXCLUDED rather than counted as either - an objection
 * nobody has ruled on is not evidence in either direction, and folding them in
 * would let the rate drift toward whichever default was chosen.
 */
export async function objectionRecord(
  pool: pg.Pool,
  projectId?: string | null,
): Promise<{ judged: number; right: number }> {
  const r = await pool.query<{ judged: string; right: string }>(
    `SELECT count(*) AS judged, count(*) FILTER (WHERE was_right) AS right
       FROM objections
      WHERE was_right IS NOT NULL
        AND ($1::uuid IS NULL OR project_id = $1)`,
    [projectId ?? null],
  );
  return { judged: Number(r.rows[0].judged), right: Number(r.rows[0].right) };
}
