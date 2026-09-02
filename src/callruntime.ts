import type pg from "pg";
import { pickLine, recordSpeech, subjectOf, type SpeechKind } from "./callbank.js";
import { triage } from "./callagent.js";
import { speakable } from "./speakable.js";
import { ingestUserMessage } from "./inbox.js";
import { createTask } from "./work.js";

/**
 * The conversational orchestration runtime (plan S21).
 *
 * Three things run at once, which is why this is a runtime and not a request
 * handler:
 *
 *   1. the voice loop — listening, endpointing, speaking (S19/S20, elsewhere);
 *   2. the tool track — capture, routing and the desk, running asynchronously
 *      and never holding the line;
 *   3. this — the speech scheduler, which decides what to say and when, given
 *      what the tool track is doing and whether Enrique is talking.
 *
 * The governing trade-off, in the plan's words: "On the phone, fast and shallow
 * beats slow and deep. Every time." A twenty-second silence while a model
 * reasons is a worse experience than an immediate "I don't know off-hand, I've
 * put it in the queue" — so there is a hard phone-side budget, and when it
 * expires the work goes to the queue and the caller is told so plainly.
 *
 * What makes that safe is that capture is independent of conversation quality.
 * Every utterance goes through `ingestUserMessage` — the same path a WhatsApp
 * message takes — before anything is spoken about it. A call where Jarvis
 * sounds vague still files three correctly-scoped tasks.
 */

/**
 * The turn shape, in milliseconds.
 *
 * `JARVIS_TURN_SCALE` shrinks all four together for the tests: the ladder is
 * about ratios and ordering, and a suite that spends 25 real seconds per
 * assertion is a suite that stops being run. The shipped numbers are the plan's.
 */
const SCALE = Number(process.env.JARVIS_TURN_SCALE ?? 1);
export const TURN_MS = {
  /** Nothing has been said yet: acknowledge. The plan's budget is ≤700ms. */
  ack: Math.round(600 * SCALE),
  /** Still going: a short holding line. */
  checking: Math.round(2_500 * SCALE),
  /** Still going: a real progress line, not a repeat. */
  progress: Math.round(10_000 * SCALE),
  /** Still going: hand it to the desk and give the turn back. */
  budget: Math.round(25_000 * SCALE),
  /**
   * The whole turn, end to end, including the render and the speaking.
   *
   * Every leg can be inside its own budget while the caller waits sixteen
   * seconds — which is what a real call did — so the turn has one too.
   */
  whole: Math.round(20_000 * SCALE),
};

/** How a line actually reaches the caller. Injected so this module never imports the carrier. */
export type Speaker = (text: string, kind: SpeechKind) => Promise<boolean>;

/** What the runtime needs to know about the call it is running a turn for. */
export type TurnContext = {
  ccid: string;
  conversationId: string;
  inboxId: string;
  heard: string;
  speak: Speaker;
  /** Called when the turn is over and the caller may speak again. */
  release: () => Promise<void>;
  /** Whether the call is still live and quiet enough to be spoken to. */
  canSpeak: () => Promise<boolean>;
};

type Live = {
  ccid: string;
  turnId: number;
  heard: string;
  timers: NodeJS.Timeout[];
  cancelled: boolean;
  /** Serialises speech so two lines never overlap. */
  chain: Promise<unknown>;
};

const live = new Map<string, Live>();

/**
 * Stop everything this call is saying or about to say.
 *
 * The plan is specific about what "cancel" has to reach: "If barge-in leaves it
 * talking, something downstream of the cancel is still holding audio: cancel the
 * render *and* flush the queued playback, not just the current one." The timers
 * are the queued playback — a progress line scheduled for eight seconds' time is
 * audio that has not been rendered yet, and it has to go too.
 */
export function cancelTurn(ccid: string): boolean {
  const t = live.get(ccid);
  if (!t) return false;
  t.cancelled = true;
  for (const timer of t.timers) clearTimeout(timer);
  t.timers = [];
  live.delete(ccid);
  return true;
}

/** Is a turn in flight for this call? */
export function turnInFlight(ccid: string): boolean {
  return live.has(ccid);
}

function later(t: Live, ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    if (t.cancelled) return;
    fn();
  }, ms);
  timer.unref?.();
  t.timers.push(timer);
}

/** Speak, but only if this turn is still the current one. */
async function saySafely(t: Live, ctx: TurnContext, text: string, kind: SpeechKind): Promise<boolean> {
  if (t.cancelled) return false;
  const done = t.chain.then(async () => {
    if (t.cancelled) return false;
    return await ctx.speak(text, kind);
  });
  t.chain = done.catch(() => undefined);
  return await done;
}

async function openTurn(pool: pg.Pool, ctx: TurnContext): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO call_turns (call_control_id, n, heard, inbox_event_id)
     SELECT $1, COALESCE(max(n), 0) + 1, $2, $3 FROM call_turns WHERE call_control_id = $1
     RETURNING id`,
    [ctx.ccid, ctx.heard.slice(0, 8000), ctx.inboxId],
  );
  return Number(r.rows[0].id);
}

async function finishTurn(
  pool: pg.Pool,
  turnId: number,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool
    .query(`UPDATE call_turns SET ${sets} WHERE id = $1`, [turnId, ...keys.map((k) => fields[k])])
    .catch((err) => console.error("could not close the turn:", err));
}

/**
 * Run one turn.
 *
 * Returns when the caller has been answered or told the work has moved to the
 * desk — never when the work itself is finished, which is the point.
 */
export async function runTurn(pool: pg.Pool, ctx: TurnContext): Promise<string> {
  cancelTurn(ctx.ccid);
  const startedAt = Date.now();
  const turnId = await openTurn(pool, ctx);
  const t: Live = {
    ccid: ctx.ccid, turnId, heard: ctx.heard, timers: [], cancelled: false, chain: Promise.resolve(),
  };
  live.set(ctx.ccid, t);

  let spokenSomething = false;

  /*
   * The tool track. Started FIRST and never awaited here: this is the call that
   * captures the utterance, routes it through S3 exactly as a WhatsApp message
   * would be, and — when routing does not handle it outright — runs the desk.
   * Whether the conversation goes well has no bearing on whether it runs.
   */
  await pool.query("UPDATE call_turns SET tool_started_at = now() WHERE id = $1", [turnId]);
  const deskAt = Date.now();
  /*
   * What the ROUTER made of it, as soon as it knows.
   *
   * The handover needs this. On a real call the desk took 25 seconds and the
   * handover created a task of its own — while the router was in the middle of
   * creating the correctly-scoped one. Two tasks for one sentence, and the
   * handover's had no project, so the runner had no repo, so the harness wrote
   * outside its worktree and the isolation tripwire killed the run. One
   * missing fact at the top of that chain.
   */
  let routed: { tasks: string[]; passthrough: boolean } | null = null;
  const work = ingestUserMessage(pool, {
    conversationId: ctx.conversationId,
    body: ctx.heard,
    inboxId: ctx.inboxId,
    onRouted: (r) => { routed = r; },
  })
    .then((r) => ({ ok: true as const, answer: r.assistant ?? null }))
    .catch((err) => {
      console.error("phone tool track failed:", err instanceof Error ? err.message : err);
      return { ok: false as const, answer: null };
    })
    .finally(() => {
      void pool
        .query("UPDATE call_turns SET tool_ended_at = now() WHERE id = $1", [turnId])
        .catch(() => undefined);
    });

  // Tier 1, in parallel: tool-less, sub-second, and the only thing allowed to
  // answer a greeting without waiting for the desk.
  const fast = triage(pool, ctx.heard).catch(() => null);

  const subject = await subjectOf(pool, ctx.heard).catch(() => null);

  /*
   * The acknowledgement. Scheduled rather than spoken outright: if tier 1 comes
   * back inside the window with a real answer, the plan says answer directly,
   * no filler. Filler that arrives before an answer that was already ready is
   * just noise.
   */
  const ackTimer = new Promise<void>((resolve) => {
    later(t, TURN_MS.ack, () => {
      void (async () => {
        if (!spokenSomething) {
          const line = await pickLine(pool, { ccid: ctx.ccid, kind: "ack", turnId, subject });
          if (await saySafely(t, ctx, line, "ack")) {
            spokenSomething = true;
            await finishTurn(pool, turnId, { ack_ms: Date.now() - startedAt, ack_text: line });
          }
        }
        resolve();
      })();
    });
  });
  void ackTimer;

  // ---------------------------------------------------------------- tier 1
  const verdict = await Promise.race([
    fast,
    new Promise<null>((r) => { const x = setTimeout(() => r(null), TURN_MS.checking); x.unref?.(); }),
  ]);

  if (verdict && verdict.mode === "answer" && !t.cancelled) {
    // A greeting, a thank-you, the time of day. Answer and stop — the desk's
    // own answer still lands in the thread, it is simply not read aloud.
    const modelMs = Date.now() - startedAt;
    const said = await saySafely(t, ctx, verdict.say, "answer");
    spokenSomething = spokenSomething || said;
    await finishTurn(pool, turnId, {
      answer_text: verdict.say, answered_at: new Date(), outcome: said ? "answered" : "interrupted",
      // Said by tier 1, so `model_ms` here is the whole time the caller waited
      // for an answer - the number the sub-second requirement is about.
      answered_by: "tier1",
      model_ms: modelMs, total_ms: Date.now() - startedAt,
    });
    await recordSpeech(pool, { ccid: ctx.ccid, turnId, kind: "answer", text: verdict.say });
    cancelTurn(ctx.ccid);
    await ctx.release();
    void deferred(pool, ctx, work, { turnId, spoken: true });
    return `answered fast in ${Date.now() - startedAt}ms`;
  }

  // ------------------------------------------------------------ the ladder
  let handedOver = false;
  later(t, TURN_MS.checking, () => {
    void (async () => {
      const line = await pickLine(pool, { ccid: ctx.ccid, kind: "checking", turnId, subject });
      if (await saySafely(t, ctx, line, "checking")) spokenSomething = true;
    })();
  });
  later(t, TURN_MS.progress, () => {
    void (async () => {
      const line = await pickLine(pool, { ccid: ctx.ccid, kind: "progress", turnId });
      if (await saySafely(t, ctx, line, "progress")) spokenSomething = true;
    })();
  });

  const budget = new Promise<"budget">((resolve) => {
    later(t, TURN_MS.budget, () => resolve("budget"));
  });

  const outcome = await Promise.race([work, budget]);

  /*
   * Stop the ladder the instant the work returns.
   *
   * On the call of 2026-09-02 a progress line was spoken at 12:25:04, four
   * seconds AFTER the answer had started playing at 12:25:00: the timer was
   * only cancelled once the answer had finished being spoken, and speaking is
   * not instant. Nothing scheduled may outlive the thing it was scheduled to
   * cover.
   */
  for (const timer of t.timers) clearTimeout(timer);
  t.timers = [];

  if (outcome === "budget") {
    /*
     * The phone-side budget is up. The work does not stop — it moves. The task
     * carries the FULL request, not a summary of it: the plan says so, and a
     * summarised request is a request the desk has to guess at.
     */
    handedOver = true;

    /*
     * If the router already filed it, the handover has nothing to file. Saying
     * so is the whole job: "the desk is still working on the thing you asked
     * for" is true, and a second task for the same sentence is not.
     */
    const already = (routed as { tasks: string[] } | null)?.tasks ?? [];
    if (already.length) {
      const line = await pickLine(pool, { ccid: ctx.ccid, kind: "handover", turnId });
      const said = await saySafely(t, ctx, line, "handover");
      await finishTurn(pool, turnId, {
        outcome: said ? "handed_over" : "interrupted",
        handover_task_id: already[0],
        total_ms: Date.now() - startedAt,
      });
      cancelTurn(ctx.ccid);
      await ctx.release();
      void deferred(pool, ctx, work, { turnId, spoken: false });
      return `handed over after ${Date.now() - startedAt}ms, already filed as ${already[0]}`;
    }

    const taskId = await createTask(pool, {
      projectId: null,
      conversationId: ctx.conversationId,
      originInboxId: ctx.inboxId,
      title: ctx.heard.slice(0, 120),
      objective: ctx.heard,
      lane: "heavy",
      priority: "normal",
      cause: "handed over from a phone call: the phone-side budget expired",
    }).catch((err) => {
      console.error("handover task could not be created:", err instanceof Error ? err.message : err);
      return null;
    });

    const line = await pickLine(pool, { ccid: ctx.ccid, kind: "handover", turnId });
    const said = await saySafely(t, ctx, line, "handover");
    await finishTurn(pool, turnId, {
      outcome: said ? "handed_over" : "interrupted",
      handover_task_id: taskId,
      total_ms: Date.now() - startedAt,
    });
    cancelTurn(ctx.ccid);
    await ctx.release();
    void deferred(pool, ctx, work, { turnId, spoken: false });
    return `handed over after ${Date.now() - startedAt}ms${taskId ? `, task ${taskId}` : ""}`;
  }

  // ------------------------------------------------------------ the answer
  const modelMs = Date.now() - deskAt;
  const written = outcome.answer
    ?? "I could not get to the bottom of that on the line. It is saved and I will follow up.";

  /*
   * The desk answers in writing; the line needs speech.
   *
   * A real call was answered with the desk's written reply — bold, bullets,
   * emoji, model version strings, 150 words. ElevenLabs took 7.4s to render it,
   * the caller heard seven seconds of it, and the rest was cut off. The
   * transcript read beautifully and the call delivered almost none of it.
   */
  const spokenForm = speakable(written);
  let answer = spokenForm.say;

  // Say where it came from, when it came from somewhere.
  const source = await citeSources(pool, ctx.inboxId).catch(() => null);
  if (source && !answer.toLowerCase().includes(source.toLowerCase())) {
    answer = `${answer.replace(/\s+$/, "").replace(/\.$/, "")} — that is from ${source}.`;
  }
  const ttsAt = Date.now();
  const said = await saySafely(t, ctx, answer, "answer");
  await finishTurn(pool, turnId, {
    answer_text: answer,
    answered_at: new Date(),
    outcome: said ? (outcome.ok ? "answered" : "failed") : "interrupted",
    // Said by the desk, which has tools and deliberates. Its `model_ms` is
    // measured from when the desk began, not from the top of the turn, so the
    // two are not comparable and must not be averaged together.
    answered_by: "desk",
    model_ms: modelMs,
    tts_ms: Date.now() - ttsAt,
    total_ms: Date.now() - startedAt,
  });
  if (said) await recordSpeech(pool, { ccid: ctx.ccid, turnId, kind: "answer", text: answer });
  cancelTurn(ctx.ccid);
  if (!said) await ctx.release();

  /*
   * Budget the WHOLE turn, not each leg.
   *
   * The call that prompted this was 846ms of acknowledgement, 8.5s of model and
   * 7.4s of render: every leg inside its own budget, and sixteen seconds of a
   * caller waiting. A turn that takes this long is a defect even when nothing
   * failed, so it leaves a ticket rather than only a number in a column.
   */
  const total = Date.now() - startedAt;
  if (total > TURN_MS.whole) {
    const { raiseIssue } = await import("./notify.js");
    await raiseIssue(pool, {
      category: "resource.cpu",
      service: "phone",
      title: "[phone] a spoken turn took longer than the whole-turn budget",
      dedupeKey: "phone.turn-over-budget",
      evidence: {
        call_control_id: ctx.ccid, total_ms: total, model_ms: modelMs,
        budget_ms: TURN_MS.whole, said: ctx.heard.slice(0, 120),
      },
      requiredAction: "Read call_turns for the per-leg split before touching any prompt.",
    }).catch(() => undefined);
  }
  return handedOver ? "handed over" : `answered in ${total}ms`;
}

/**
 * A result that arrived after the conversation moved on.
 *
 * One of the three cases in which the runtime may speak without being asked:
 * "that Alpha question — it was the migration". Only if the line is still open
 * and quiet, only once, and never for a turn that was already read aloud.
 */
async function deferred(
  pool: pg.Pool,
  ctx: TurnContext,
  work: Promise<{ ok: boolean; answer: string | null }>,
  args: { turnId: number; spoken: boolean },
): Promise<void> {
  const result = await work.catch(() => null);
  if (!result?.answer || args.spoken) return;
  if (!(await ctx.canSpeak().catch(() => false))) return;
  if (turnInFlight(ctx.ccid)) return;

  const subject = await subjectOf(pool, ctx.heard).catch(() => null);
  const lead = subject
    ? `That ${subject} question — `
    : "Coming back to what you asked — ";
  const line = `${lead}${result.answer}`;
  await recordSpeech(pool, { ccid: ctx.ccid, turnId: args.turnId, kind: "answer", text: line });
  await ctx.speak(line, "answer").catch(() => false);
}

/**
 * Where a spoken answer came from.
 *
 * The plan's test is "the answer is correct and cites what it came from". The
 * citation is read from `audit_events` — the row the Supervisor writes when a
 * tool ACTUALLY RUNS — rather than asked of the model, because a model asked to
 * name its sources will happily name one it did not use. If no tool ran, nothing
 * is appended: an answer from the model's own head must not be dressed up as a
 * lookup.
 */
const SOURCE_NAMES: Record<string, string> = {
  task_create: "the queue",
  memory_search: "your memory",
  memory_upsert: "your memory",
  project_list: "your projects",
  connection_list: "your connections",
  issue_create: "the open issues",
  models_list: "the model registry",
  conversation_create: "your threads",
};

export async function citeSources(pool: pg.Pool, inboxId: string): Promise<string | null> {
  const r = await pool.query<{ target: string }>(
    `SELECT DISTINCT target FROM audit_events
     WHERE actor = 'supervisor' AND action = 'supervisor.tool'
       AND metadata->>'inbox_id' = $1
     ORDER BY target`,
    [inboxId],
  );
  const named = [...new Set(r.rows.map((x) => SOURCE_NAMES[x.target]).filter(Boolean))];
  if (!named.length) return null;
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** Per-leg timings for a call, for the console and for "it felt slow". */
export async function turnTimings(
  pool: pg.Pool,
  ccid: string,
): Promise<{ n: number; ack_ms: number | null; total_ms: number | null; outcome: string }[]> {
  const r = await pool.query<{ n: number; ack_ms: number | null; total_ms: number | null; outcome: string }>(
    `SELECT n, ack_ms, total_ms, outcome FROM call_turns WHERE call_control_id = $1 ORDER BY n`,
    [ccid],
  );
  return r.rows;
}
