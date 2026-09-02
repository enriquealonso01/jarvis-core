import type pg from "pg";

/**
 * What Jarvis says while it is working, and the rule that it is never the same
 * thing twice (plan S21).
 *
 * "The single thing that makes a voice agent feel dead is the same phrase every
 * time." So this is a pool per situation, with the no-repeat state living on the
 * CALL — in `call_speech`, not in a variable that a restart or a second request
 * would lose. The plan names that failure specifically.
 *
 * Content-aware where it can be: "let me pull up Alpha" is not "let me check
 * that". Naming the thing proves it was heard, and that is the whole difference
 * between an acknowledgement and a stall.
 */

export type SpeechKind = "ack" | "checking" | "progress" | "handover" | "answer" | "closing" | "holding";

/** Said immediately, inside ~700ms, before anything has been looked at. */
const ACK = [
  "Let me look.",
  "One moment.",
  "Right — checking.",
  "Sure, let me see.",
  "Hold on, sir.",
  "Let me find out.",
];

/** Said when the tool track is still going at ~2.5s. */
const CHECKING = [
  "Still pulling that up.",
  "Bear with me a second.",
  "Nearly there.",
  "Just reading it now.",
  "Getting that for you.",
];

/**
 * Said at ~10s. These have to say something NEW — "a second 'still working on
 * it' is worse than silence, because it proves nothing is happening."
 */
const PROGRESS = [
  "This one is taking longer than I would like — still going.",
  "It is a bigger lookup than I thought; I am on it.",
  "Sorry, sir, this is slow. I have not forgotten you.",
  "Still running. If it drags much further I will hand it to the desk.",
];

/** Said at the phone-side budget, when the work moves to the queue. */
const HANDOVER = [
  "I will have the desk finish this and come back to you.",
  "That needs more than I can do on the line — it is queued, and I will follow up.",
  "I am handing this to the desk, sir; you will have it shortly.",
];

const CLOSING = [
  "I will let you go, sir. Call back any time.",
  "Right you are, sir. I will get on with it.",
];

const BANK: Record<string, string[]> = {
  ack: ACK, checking: CHECKING, progress: PROGRESS, handover: HANDOVER, closing: CLOSING,
};

/**
 * The lines said BEFORE the desk has done anything.
 *
 * Kept separate because they are held to a stricter rule than the rest: nothing
 * here may claim an action, since at the moment they are spoken none has been
 * taken. The handover line is not among them — by the time it is said a task
 * really has been created, so "it is queued" is a fact rather than a claim.
 */
export function linesBeforeAnythingHappened(): string[] {
  return [...ACK, ...CHECKING, ...PROGRESS];
}

/** Every fixed line, for pre-rendering: a known phrase must never pay for synthesis twice. */
export function everyFixedLine(): string[] {
  return [...ACK, ...CHECKING, ...PROGRESS, ...HANDOVER, ...CLOSING];
}

/**
 * The thing being asked about, if it can be named from the words themselves.
 *
 * Deliberately narrow: a real project name, or a capitalised proper noun the
 * caller used. Guessing a subject and getting it wrong is worse than not naming
 * one — "let me pull up the deploy" when he asked about billing is a machine
 * pretending to have understood.
 */
export async function subjectOf(pool: pg.Pool, text: string): Promise<string | null> {
  const lower = text.toLowerCase();
  const projects = await pool
    .query<{ name: string }>("SELECT name FROM projects WHERE is_system = false")
    .catch(() => ({ rows: [] as { name: string }[] }));
  for (const p of projects.rows) {
    if (p.name && lower.includes(p.name.toLowerCase())) return p.name;
  }
  // A capitalised word that is not the first word of the sentence and is not a
  // name Jarvis uses for people.
  const proper = text
    .split(/\s+/)
    .slice(1)
    .find((w) => /^[A-Z][a-zA-Z0-9-]{2,}$/.test(w) && !/^(Jarvis|Enrique|I)$/.test(w));
  return proper ?? null;
}

/** What was already said on this call, by kind, most recent first. */
async function alreadySaid(pool: pg.Pool, ccid: string, kind: SpeechKind): Promise<string[]> {
  const r = await pool.query<{ text: string }>(
    `SELECT text FROM call_speech WHERE call_control_id = $1 AND kind = $2 ORDER BY at DESC, id DESC`,
    [ccid, kind],
  );
  return r.rows.map((x) => x.text);
}

/**
 * Choose a line, record it, and never say the same one twice in a row.
 *
 * Acknowledgements avoid the PREVIOUS one; progress lines avoid EVERY previous
 * one, because a progress line repeated later in the same call is exactly the
 * "still working on it" that proves nothing is happening. When the pool is
 * exhausted the constraint relaxes to "not the last one" rather than falling
 * silent — silence is not the better failure here.
 */
export async function pickLine(
  pool: pg.Pool,
  args: { ccid: string; kind: SpeechKind; turnId?: number | null; subject?: string | null },
): Promise<string> {
  const pool_ = BANK[args.kind] ?? ACK;
  const said = await alreadySaid(pool, args.ccid, args.kind);

  // Content-aware acknowledgement, offered as one more option rather than as a
  // replacement: naming the subject every single time is its own monotony.
  const options = [...pool_];
  if (args.subject && (args.kind === "ack" || args.kind === "checking")) {
    options.unshift(`Let me pull up ${args.subject}.`, `Checking ${args.subject} now.`);
  }

  const banned = args.kind === "progress" ? new Set(said) : new Set(said.slice(0, 1));
  let choices = options.filter((o) => !banned.has(o));
  if (!choices.length) choices = options.filter((o) => o !== said[0]);
  if (!choices.length) choices = options;

  const line = choices[Math.floor(Math.random() * choices.length)];
  await recordSpeech(pool, { ccid: args.ccid, turnId: args.turnId ?? null, kind: args.kind, text: line });
  return line;
}

/** Write down what was said, so the next choice can avoid it and a test can check it. */
export async function recordSpeech(
  pool: pg.Pool,
  args: { ccid: string; turnId?: number | null; kind: SpeechKind; text: string },
): Promise<void> {
  await pool
    .query(
      `INSERT INTO call_speech (call_control_id, turn_id, kind, text) VALUES ($1,$2,$3,$4)`,
      [args.ccid, args.turnId ?? null, args.kind, args.text.slice(0, 2000)],
    )
    .catch((err) => console.error("could not record what was said:", err));
}

/** Everything said on a call, in order — the transcript the variety test greps. */
export async function spokenOnCall(
  pool: pg.Pool,
  ccid: string,
): Promise<{ kind: string; text: string }[]> {
  const r = await pool.query<{ kind: string; text: string }>(
    `SELECT kind, text FROM call_speech WHERE call_control_id = $1 ORDER BY at, id`,
    [ccid],
  );
  return r.rows;
}
