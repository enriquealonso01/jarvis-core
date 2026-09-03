/**
 * Live voice in the browser (plan S49).
 *
 * The step is explicit that this is "a new transport and a UI, **not a second
 * conversation brain**" — S21's runtime, S20's turn-taking, S39's channel rules
 * are all reused. So this file holds only the parts that are genuinely new, and
 * each of them is a rule the browser makes newly easy to get wrong.
 *
 * THREE OF THEM.
 *
 * ONE: **the console proves who; the approval page still proves what.**
 *
 *   "A live browser call rides an **authenticated console session**, so unlike a
 *    raw phone call it establishes *who* — but being on a console page supplies
 *    only the first half... **The voice channel is not an approval surface, and
 *    this is the single most likely place to break that rule, because talking to
 *    Jarvis on the console page feels like authority it does not carry.**"
 *
 * So a spoken instruction produces a REQUEST. `spokenInstruction` returns a
 * decision whose `executes` is the literal `false`; there is no branch, no flag
 * and no argument that makes a voice utterance carry out a Level 3 action.
 *
 * TWO: **the orb reflects reality, or it is a lie with an animation.**
 *
 *   "The moving circle is bound to **real signals only**... **It never moves
 *    because time passed** (0.45: fake progress indicators are forbidden, and a
 *    decorative pulse on an idle call is exactly that)."
 *
 * `orbState` therefore takes amplitude, playback level and track state — and NO
 * clock, no elapsed time, no frame counter. A timer-driven orb is not discouraged
 * here; it is unwritable, because there is nothing in scope to drive it.
 *
 * THREE: **the screen is the divergence from the phone, and it is an upgrade.**
 *
 *   "S39 forbids a URL down the voice channel because the phone has no screen.
 *    The browser call **has one**... Jarvis says *I've put it on screen* rather
 *    than *I'm sending it to WhatsApp*."
 *
 * The spoken line still never contains the URL — S39 is unchanged — but the
 * promise it makes is different, and the link goes to the thread beside the orb.
 */
import { speakableWithLinks } from "./speakable.js";

/* ------------------------------------------------------------------ *
 * The console proves who. It does not prove what.
 * ------------------------------------------------------------------ */

export type SpokenOutcome = {
  /** Always false. See the header: this is the rule most likely to be broken. */
  executes: false;
  /** What happens instead. */
  raises: "approval" | "task";
  say: string;
  why: string;
};

/**
 * What a spoken instruction on a browser call does.
 *
 * `executes` is the literal `false`, not `boolean`, so a version of this that
 * could execute has to change the type and every caller rather than adding a
 * branch somebody reviews on its own. An authenticated session is a claim about
 * WHO is speaking; it says nothing about whether this particular action should
 * happen, and the approval page is where that second question is answered with
 * re-authentication.
 */
export function spokenInstruction(args: {
  utterance: string;
  /** True for the actions IV.6 puts behind an approval. */
  needsApproval: boolean;
}): SpokenOutcome {
  if (args.needsApproval) {
    return {
      executes: false,
      raises: "approval",
      say: "I've raised that as an approval — it needs you to sign in again on the approval page.",
      why: "the console session establishes who is speaking, not that this action may happen; "
        + "talking on the console page feels like authority it does not carry",
    };
  }
  return {
    executes: false,
    raises: "task",
    say: "Queued.",
    why: "a spoken request goes onto the same capture and routing path as WhatsApp and the phone",
  };
}

/* ------------------------------------------------------------------ *
 * The orb, bound to real signals only.
 * ------------------------------------------------------------------ */

export type TrackState = "listening" | "thinking" | "answering" | "handed_to_desk";

export type Orb = {
  state: TrackState | "idle";
  /** 0 to 1. What actually drives the motion. */
  motion: number;
  why: string;
};

/**
 * What the circle is doing.
 *
 * Note the parameters: amplitude, playback level, track state. There is no clock
 * here and nothing derived from one. "It never moves because time passed" is
 * therefore a property of what this function can see, rather than a note asking
 * the next person not to add a pulse.
 *
 * A muted microphone contributes no amplitude, so the motion stops on its own -
 * that is not a special case, it is the same rule.
 */
export function orbState(signals: {
  /** 0 to 1, from the microphone. Zero while muted. */
  micAmplitude: number;
  /** 0 to 1, from playback. Zero while Jarvis is not speaking. */
  playbackLevel: number;
  track: TrackState | null;
}): Orb {
  const mic = clamp(signals.micAmplitude);
  const playback = clamp(signals.playbackLevel);

  if (signals.track === "thinking" || signals.track === "handed_to_desk") {
    /*
     * A running tool track "shows the thinking state, NOT A SPIN". The motion is
     * zero because nothing audible is happening; the STATE is what tells him
     * something is going on, and it is honest about what.
     */
    return {
      state: signals.track,
      motion: 0,
      why: signals.track === "thinking"
        ? "a tool is running — shown as thinking rather than as movement, because nothing is being said"
        : "handed to the desk",
    };
  }
  if (playback > 0) {
    return { state: "answering", motion: playback, why: "driven by playback level" };
  }
  if (mic > 0) {
    return { state: "listening", motion: mic, why: "driven by microphone amplitude" };
  }
  /*
   * Nothing is happening, so nothing moves. A decorative pulse here is exactly
   * the fake progress indicator 0.45 forbids.
   */
  return { state: "idle", motion: 0, why: "nothing is happening, so nothing moves" };
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/* ------------------------------------------------------------------ *
 * The screen, which the phone does not have.
 * ------------------------------------------------------------------ */

export type BrowserDelivery = {
  /** Exactly what is synthesised. Never contains an address. */
  say: string;
  /** What appears in the thread beside the orb. */
  onScreen: string[];
};

/**
 * A link produced during a browser call.
 *
 * S39's rule is unchanged — no address is spoken, because a URL is not followable
 * by ear whatever screen happens to be nearby. What changes is where it goes and
 * therefore what the spoken line promises: the thread beside the orb rather than
 * WhatsApp.
 */
export function deliverInBrowser(line: string): BrowserDelivery {
  const plan = speakableWithLinks(line);
  if (!plan.links.length) return { say: plan.say, onScreen: [] };

  /*
   * The WhatsApp promise is replaced rather than appended. Saying both would tell
   * him to look in two places for one link, and the one he is looking at already
   * has it.
   */
  /*
   * Matched against speakable.ts's own sentence rather than a guessed one. The
   * first version looked for "I'm sending" and the real wording is "I am
   * sending", so the promise survived and the line offered him two places to
   * find one link - which the suite caught. Both counts are handled because
   * speakable pluralises.
   */
  const say = plan.say
    .split(". ")
    .filter((sentence) => !/I am sending you the (link|\d+ links) on WhatsApp/i.test(sentence))
    .join(". ")
    .replace(/\s+$/, "");
  /*
   * The split consumes the separator, so the sentence before the removed promise
   * loses its full stop. Restored rather than left, because this is read aloud
   * and a synthesiser runs the two sentences together without it.
   */
  const stopped = /[.!?]$/.test(say) ? say : `${say}.`;
  return {
    say: `${stopped} I've put it on screen.`.replace(/\s+/g, " ").trim(),
    onScreen: plan.links,
  };
}

/* ------------------------------------------------------------------ *
 * When the transport will not start.
 * ------------------------------------------------------------------ */

export type Fallback = {
  mode: "live" | "one_shot";
  say: string;
};

/**
 * Microphone denied, or WebRTC unavailable.
 *
 * "It **falls back to the existing one-shot recording composer** with a plain
 * message, **not a dead button**." The composer already exists, so the fallback
 * is a mode rather than a feature — and the message says what he can still do
 * rather than what failed.
 */
export function transportFallback(args: {
  micGranted: boolean;
  webrtcAvailable: boolean;
}): Fallback {
  if (args.micGranted && args.webrtcAvailable) {
    return { mode: "live", say: "Listening." };
  }
  const reason = !args.micGranted
    ? "I can't reach the microphone"
    : "a live call won't connect from this browser";
  return {
    mode: "one_shot",
    say: `${reason} — record a message instead and I'll pick it up the same way.`,
  };
}

/**
 * Capture before anything else happens.
 *
 * "Every utterance becomes a **durable Inbox Event before any model sees it**...
 * Persist-first, no second input path. **Ending or dropping the call loses
 * nothing.**"
 *
 * Written as an order rather than a comment: the caller is handed a function that
 * persists and only then returns something a model can be asked about, so
 * "persist first" is the shape of the call rather than a step that can be skipped
 * when the transport is in a hurry.
 */
export async function captureThenAsk<T>(
  persist: () => Promise<string>,
  ask: (inboxEventId: string) => Promise<T>,
): Promise<{ inboxEventId: string; answer: T }> {
  const inboxEventId = await persist();
  const answer = await ask(inboxEventId);
  return { inboxEventId, answer };
}
