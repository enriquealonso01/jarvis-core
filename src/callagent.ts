import type pg from "pg";
import { quickCompletion, runSupervisorTurn } from "./supervisor.js";
import { tierOneClaims } from "./callclaims.js";

/**
 * The two-tier call agent.
 *
 * One agent cannot be both conversational and capable. Trying made spoken turns
 * either slow (a reasoning model deliberating over eleven tool schemas, 15s) or
 * thin (a cheap model that cannot actually do anything). So the roles split:
 *
 *   Tier 1 — the voice. Cheap, no tools at all, reasoning off. Measured on the
 *            Fireworks route, a tool-less turn is 341-622ms every time, while
 *            five tools produced occasional 1.7s deliberations. Its only job is
 *            to decide whether it can answer outright or must hand over, and to
 *            say something human immediately either way.
 *
 *   Tier 2 — the desk. Today's full Supervisor: every tool, reasoning on, no
 *            latency budget. Runs after the caller has already been answered.
 *
 * Tier 1 never claims work is done. It cannot know — it has no tools — so its
 * acknowledgements are written to say "passed to the desk", never "done".
 */

export type Triage =
  | { mode: "answer"; say: string }
  | { mode: "delegate"; say: string; request: string };

// Exported so a latency suite can measure the REAL prompt: prefill of this
// text is most of tier 1 latency, and measuring a shorter stand-in flatters the
// result by about a second.
export const TRIAGE_SYSTEM =
  `You are Jarvis answering Enrique's phone.

`
  + `You have NO tools, NO memory, and NO access to any data. You cannot look anything up.
`
  + `You do not know what he has told you before. You do not know his projects, models,
`
  + `spend, connections, schedules or issues. Guessing at any of it would be a lie.

`
  + `Output exactly one line.

`
  + `ANSWER: <one short sentence>
`
  + `  ONLY for: greetings, how are you, thanks, goodbye, who or what are you, and the
`
  + `  time of day. Nothing else. If the reply would contain any fact about his work,
`
  + `  it is not an ANSWER.

`
  + `DELEGATE: <one short sentence saying you are passing it to the desk>
`
  + `  EVERYTHING else. Every question starting what/which/when/where/how many/how much,
`
  + `  anything about memory or "what did I tell you", anything naming a project, model,
`
  + `  cost, connection or number, and every instruction to do, change, store or check.
`
  + `  When unsure, DELEGATE - it is always the safe choice.

`
  + `Speak as a butler; you may say "sir" occasionally, never twice in a reply.
`
  + `Never say a thing is done, stored, created or changed - you cannot do any of it.
`
  + `One line, starting with ANSWER: or DELEGATE:.`;

/**
 * Tier 1. Deliberately does not go through `runSupervisorTurn`: no tools, no
 * memory injection, no history beyond the caller's sentence. That is the whole
 * point — it is the only configuration measured to answer in under a second
 * every single time.
 */
export async function triage(
  pool: pg.Pool,
  text: string,
  opts: { onRoute?: (route: { provider: string; model: string }) => void } = {},
): Promise<Triage> {
  /*
   * The UTILITY route, not the supervisor one.
   *
   * `quickCompletion` defaults to the supervisor role, so tier 1 - the tool-less
   * turn whose entire purpose is to answer before the caller notices a pause -
   * was being served by the same large model as the desk. Measured on the box,
   * three trivial turns each way: supervisor averaged 1288ms and peaked at
   * 1795ms; utility averaged 495ms and peaked at 578ms. Same answers, a third
   * of the wait.
   *
   * `maxTokens` is small on purpose too: tier 1 is one short line by
   * specification, and a token budget is the cheapest latency control there is.
   */
  const raw = (await quickCompletion(pool, TRIAGE_SYSTEM, text, {
    role: "utility",
    maxTokens: 80,
    ...(opts.onRoute ? { onRoute: opts.onRoute } : {}),
  }))?.trim() ?? "";
  const line = raw.split("\n").find((l) => /^(ANSWER|DELEGATE)\s*:/i.test(l.trim()))?.trim();

  if (!line) {
    // An unparseable reply must not become a spoken non-answer. Delegating is
    // the safe default: the desk can handle anything, tier 1 cannot.
    return {
      mode: "delegate",
      say: "Let me pass that to the desk, sir.",
      request: text,
    };
  }

  const [, verb, said] = line.match(/^(ANSWER|DELEGATE)\s*:\s*(.*)$/i) ?? [];
  const say = (said ?? "").trim();

  /*
   * The prompt forbids claiming an action; this makes it structural.
   *
   * Tier 1 has no tools, so "I have filed that" is false by construction — and a
   * model told not to do something will still occasionally do it. The plan makes
   * this a test ("Confirm Tier 1 never says a thing was stored, created, or
   * changed. Grep the transcripts"), and a test of a prompt is a test of luck.
   * A claim is downgraded to a delegation, which is what was actually about to
   * happen anyway.
   */
  if (say && tierOneClaims(say)) {
    return {
      mode: "delegate",
      say: "Let me pass that to the desk, sir.",
      request: text,
    };
  }

  if (/^answer$/i.test(verb ?? "") && say) return { mode: "answer", say };
  return {
    mode: "delegate",
    say: say || "Passing that to the desk, sir.",
    request: text,
  };
}

/**
 * Tier 2. The full Supervisor, run after the caller has already heard something.
 *
 * Not brief: this is where the tools and the deliberation belong. Whatever it
 * returns is both spoken (if the call is still up) and left in the thread, so a
 * call that ends early still lands its work in the Control Center.
 */
export async function delegateToDesk(
  pool: pg.Pool,
  args: { conversationId: string; inboxId: string; request: string },
): Promise<string> {
  return await runSupervisorTurn(pool, {
    conversationId: args.conversationId,
    inboxId: args.inboxId,
    userText:
      `[Passed from a phone call. Enrique is on the line or has just hung up. Do the work `
      + `and answer in at most two short sentences, written to be read aloud. This channel `
      + `cannot authorise a destructive or always-confirm action: if he asked for one, say `
      + `it needs confirming in the Control Center.]\n\n${args.request}`,
  });
}
