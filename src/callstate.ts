import type pg from "pg";

/**
 * The per-call state machine, persisted (plan S19).
 *
 * `ringing → greeting → listening → thinking → speaking → closing`
 *
 * It used to be a module-level `Map` holding which calls were mid-answer, which
 * is worse than it sounds. An API restart erased it, so the next transcription
 * for a live call looked like the first one — and the runaway loop the plan
 * lists as one of the two bugs that must never come back became reachable again
 * by a deploy rather than by a code change.
 *
 * Two things follow from putting it in the database. The turn gate becomes an
 * atomic UPDATE rather than a read-then-write, so two transcriptions arriving
 * together cannot both win. And every leg carries a DEADLINE, because "a hung
 * call is almost always an awaited promise with no timeout" and a timeout that
 * only exists in a promise dies with the process.
 */

export type CallState =
  | "ringing"
  | "greeting"
  | "listening"
  | "thinking"
  | "speaking"
  | "closing"
  | "ended";

/** What each leg is allowed to take before the caller is told something. */
export const BUDGET_MS: Record<string, number> = {
  // Whisper on a short utterance. Past this the line is silent and the caller
  // starts saying "hello?".
  stt: 12_000,
  // The utility chain answers in well under a second; this is the ceiling
  // before a holding line is better than more waiting.
  model: 8_000,
  // ElevenLabs render plus the fetch.
  tts: 12_000,
  // A whole answer, end to end, as a backstop for anything not covered above.
  answer: 30_000,
  // Not a provider budget: how long a silent caller is left alone before being
  // asked whether they are still there.
  listening: 30_000,
  // How long the caller may pause mid-thought before the turn passes to Jarvis
  // (plan S20: "roughly five seconds of silence hands the turn"). Overridable
  // so a test can prove the behaviour without spending six seconds per
  // assertion; the default is what a real call uses.
  endpoint: Number(process.env.JARVIS_ENDPOINT_MS ?? 5_000),
};

/**
 * Add what was just heard to the turn in progress.
 *
 * Returns the whole utterance so far. A pause mid-sentence is not the end of a
 * turn — Telnyx emits a final per segment, so "book me a flight to Madrid, no,
 * Barcelona" arrives as two or three of them, and answering each one is how the
 * caller ends up being interrupted by their own assistant.
 */
export async function appendUtterance(
  pool: pg.Pool,
  ccid: string,
  text: string,
): Promise<string> {
  const r = await pool.query<{ pending_text: string }>(
    `UPDATE calls
     SET pending_text = CASE WHEN pending_text IS NULL OR pending_text = '' THEN $2
                             ELSE pending_text || ' ' || $2 END,
         pending_since = now(),
         -- Only while LISTENING does this own the deadline. Said over a reply,
         -- or while one is being composed, it must not overwrite the deadline
         -- that leg is relying on — the answer would then have no timeout at
         -- all, which is the exact failure the budgets exist to prevent.
         deadline_leg = CASE WHEN state = 'listening' THEN 'endpoint' ELSE deadline_leg END,
         deadline_at = CASE WHEN state = 'listening'
                            THEN now() + make_interval(secs => $3::int / 1000.0)
                            ELSE deadline_at END
     WHERE call_control_id = $1 AND ended_at IS NULL
     RETURNING pending_text`,
    [ccid, text, BUDGET_MS.endpoint],
  );
  return r.rows[0]?.pending_text ?? text;
}

/**
 * Claim the accumulated utterance, atomically, and clear it.
 *
 * Atomic because two things race for it: the in-process timer that fires when
 * the caller stops talking, and the worker sweep that exists so a restart does
 * not strand the turn. Exactly one may win, or the caller is answered twice.
 */
export async function takeUtterance(pool: pg.Pool, ccid: string): Promise<string | null> {
  /*
   * `RETURNING pending_text` after setting it to NULL returns the NEW value,
   * which is NULL — so the first version of this cleared the turn and then
   * reported that there had been nothing to say. The caller was answered with
   * silence and the words were gone. The old value has to come from a
   * subquery, locked, so two claimants still cannot both win it.
   */
  const r = await pool.query<{ pending_text: string }>(
    `UPDATE calls c SET pending_text = NULL, pending_since = NULL
     FROM (SELECT call_control_id, pending_text FROM calls
           WHERE call_control_id = $1 FOR UPDATE) old
     WHERE c.call_control_id = old.call_control_id AND c.ended_at IS NULL
       AND old.pending_text IS NOT NULL AND old.pending_text <> ''
     RETURNING old.pending_text`,
    [ccid],
  );
  return r.rows[0]?.pending_text ?? null;
}

/** Remember which playback is in the air, so barge-in stops that one. */
export async function setSpeakingMarker(
  pool: pg.Pool,
  ccid: string,
  marker: string | null,
): Promise<void> {
  await pool.query(
    "UPDATE calls SET speaking_marker = $2 WHERE call_control_id = $1",
    [ccid, marker],
  );
}

export async function countBargeIn(pool: pg.Pool, ccid: string): Promise<void> {
  await pool.query(
    "UPDATE calls SET barge_ins = barge_ins + 1 WHERE call_control_id = $1",
    [ccid],
  );
}

const ALLOWED: Record<CallState, CallState[]> = {
  ringing: ["greeting", "closing", "ended"],
  // A greeting that fails goes straight to listening rather than stranding the
  // caller on a silent line.
  greeting: ["listening", "closing", "ended"],
  listening: ["thinking", "closing", "ended"],
  thinking: ["speaking", "listening", "closing", "ended"],
  speaking: ["listening", "closing", "ended"],
  closing: ["ended"],
  ended: [],
};

export function canMove(from: CallState, to: CallState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export async function openCall(
  pool: pg.Pool,
  args: { ccid: string; legId?: string | null; from?: string | null; conversationId?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO calls (call_control_id, call_leg_id, from_e164, conversation_id, state)
     VALUES ($1,$2,$3,$4,'ringing')
     ON CONFLICT (call_control_id) DO UPDATE
       SET call_leg_id = COALESCE(EXCLUDED.call_leg_id, calls.call_leg_id),
           conversation_id = COALESCE(EXCLUDED.conversation_id, calls.conversation_id)`,
    [args.ccid, args.legId ?? null, args.from ?? null, args.conversationId ?? null],
  );
  await pool.query(
    `INSERT INTO call_transitions (call_control_id, from_state, to_state, cause, event_type)
     VALUES ($1, NULL, 'ringing', 'call arrived', 'call.initiated')`,
    [args.ccid],
  );
}

/**
 * Make sure a live call has a row, without pretending it just arrived.
 *
 * Telnyx does not guarantee delivery of every webhook, and a missed
 * `call.initiated` used to be survivable — now it would mean no state row, so
 * every gate would refuse and the caller would get a greeting and then silence.
 * Returns true when it had to invent the row, which is worth a log line.
 */
export async function ensureCall(
  pool: pg.Pool,
  args: { ccid: string; legId?: string | null; from?: string | null },
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state)
     VALUES ($1,$2,$3,'ringing') ON CONFLICT (call_control_id) DO NOTHING`,
    [args.ccid, args.legId ?? null, args.from ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function currentState(pool: pg.Pool, ccid: string): Promise<CallState | null> {
  const r = await pool.query<{ state: CallState }>(
    "SELECT state FROM calls WHERE call_control_id = $1",
    [ccid],
  );
  return r.rows[0]?.state ?? null;
}

/**
 * Move the call, atomically, only from a state the move is legal from.
 *
 * Returns false when the move was not legal — which is the turn gate: two
 * transcriptions arriving together both try `listening -> thinking` and exactly
 * one wins, because the UPDATE names the state it expects to find. The old
 * in-memory version read, decided, then wrote, and could let both through.
 */
export async function move(
  pool: pg.Pool,
  ccid: string,
  to: CallState,
  args: { from?: CallState | CallState[]; cause?: string; eventType?: string; leg?: string } = {},
): Promise<boolean> {
  const froms = args.from
    ? (Array.isArray(args.from) ? args.from : [args.from])
    : (Object.keys(ALLOWED) as CallState[]).filter((s) => canMove(s, to));
  const deadline = args.leg ? BUDGET_MS[args.leg] ?? null : null;

  const r = await pool.query<{ state: string }>(
    `UPDATE calls
     SET state = $2,
         state_at = now(),
         deadline_leg = $4,
         deadline_at = CASE WHEN $5::int IS NULL THEN NULL
                            ELSE now() + make_interval(secs => $5::int / 1000.0) END,
         turns = turns + CASE WHEN $2 = 'thinking' THEN 1 ELSE 0 END,
         ended_at = CASE WHEN $2 = 'ended' THEN now() ELSE ended_at END
     WHERE call_control_id = $1 AND state = ANY($3::text[]) AND ended_at IS NULL
     RETURNING state`,
    [ccid, to, froms, args.leg ?? null, deadline],
  );
  const moved = (r.rowCount ?? 0) > 0;
  if (moved) {
    await pool
      .query(
        `INSERT INTO call_transitions (call_control_id, from_state, to_state, cause, event_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [ccid, froms.join("|"), to, args.cause ?? null, args.eventType ?? null],
      )
      .catch(() => undefined);
  }
  return moved;
}

/**
 * Count another unanswered "are you still there?" and report the total.
 *
 * A counter rather than a boolean because the plan's silence case is two-stage:
 * prompt once, close on the second. In the row, not in memory, for the same
 * reason as everything else here.
 */
export async function bumpSilence(pool: pg.Pool, ccid: string): Promise<number> {
  const r = await pool.query<{ silence_prompts: number }>(
    `UPDATE calls SET silence_prompts = silence_prompts + 1
     WHERE call_control_id = $1 RETURNING silence_prompts`,
    [ccid],
  );
  return r.rows[0]?.silence_prompts ?? 0;
}

/** End a call and release its state, whatever it was doing. */
export async function endCall(pool: pg.Pool, ccid: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE calls SET state = 'ended', ended_at = COALESCE(ended_at, now()),
            end_reason = COALESCE(end_reason, $2), deadline_at = NULL, deadline_leg = NULL,
            state_at = now()
     WHERE call_control_id = $1`,
    [ccid, reason.slice(0, 200)],
  );
  await pool
    .query(
      `INSERT INTO call_transitions (call_control_id, from_state, to_state, cause)
       VALUES ($1, NULL, 'ended', $2)`,
      [ccid, reason.slice(0, 200)],
    )
    .catch(() => undefined);
}

/**
 * Calls whose current leg has blown its budget.
 *
 * Swept by the worker rather than by a timer inside the request that started the
 * leg: a timer dies with the process, and the whole point of persisting this is
 * that a restart mid-call does not leave the caller on a silent line.
 */
export async function overdueCalls(
  pool: pg.Pool,
): Promise<{ call_control_id: string; state: CallState; deadline_leg: string | null }[]> {
  const r = await pool.query<{ call_control_id: string; state: CallState; deadline_leg: string | null }>(
    `SELECT call_control_id, state, deadline_leg FROM calls
     WHERE ended_at IS NULL AND deadline_at IS NOT NULL AND deadline_at < now()`,
  );
  return r.rows;
}

/**
 * Live calls that have stopped moving entirely.
 *
 * The deadline covers a leg that is taking too long. This covers the case where
 * no leg is running and no event will ever arrive — mid-call network loss, a
 * webhook Telnyx never delivered, a container killed between two events. Without
 * it those rows stay live forever and every count of "calls in progress" is
 * wrong from then on.
 */
export async function stalledCalls(
  pool: pg.Pool,
  ms: number,
): Promise<{ call_control_id: string; state: CallState }[]> {
  const r = await pool.query<{ call_control_id: string; state: CallState }>(
    `SELECT call_control_id, state FROM calls
     WHERE ended_at IS NULL AND state_at < now() - make_interval(secs => $1::int / 1000.0)`,
    [ms],
  );
  return r.rows;
}

/** What to say when a leg has taken too long. Never silence. */
export function holdingLine(leg: string | null): string {
  switch (leg) {
    case "stt":
      return "Sorry — I did not catch that. Could you say it again?";
    case "model":
      return "Give me a moment, I am still thinking about that.";
    case "tts":
      return "Sorry, my voice dropped out for a second. What were you saying?";
    default:
      return "Sorry, that took longer than it should have. I am still here.";
  }
}

/** The whole ordered story of one call, for the console and for the tests. */
export async function callTimeline(
  pool: pg.Pool,
  ccid: string,
): Promise<{ from_state: string | null; to_state: string; cause: string | null; at: string }[]> {
  const r = await pool.query<{ from_state: string | null; to_state: string; cause: string | null; at: string }>(
    `SELECT from_state, to_state, cause, at::text AS at FROM call_transitions
     WHERE call_control_id = $1 ORDER BY at, id`,
    [ccid],
  );
  return r.rows;
}
