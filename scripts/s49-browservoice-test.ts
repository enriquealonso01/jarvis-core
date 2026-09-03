/**
 * S49 — live voice in the browser, and the three rules it makes easy to break.
 *
 * The plan names the first one as the single most likely failure:
 *
 *   "**The voice channel is not an approval surface, and this is the single most
 *    likely place to break that rule, because talking to Jarvis on the console
 *    page feels like authority it does not carry.**"
 *
 * And the second as a lie with an animation:
 *
 *   "**The orb-is-honest test**: mute the mic → amplitude-driven motion stops;
 *    force the tool track to run 30s → the orb shows thinking/handed-over, not a
 *    decorative spin. **Assert the animation is driven by real signals, not a
 *    timer.**"
 *
 * That one is asserted twice: on the output, and on what `orbState` can see at
 * all. A function with no clock in scope cannot animate on time passing, and that
 * is a stronger statement than any single mocked frame.
 */
import {
  captureThenAsk, deliverInBrowser, orbState, spokenInstruction, transportFallback,
} from "../src/browservoice.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const PR_URL = "https://github.test/enriquealonso01/alpha/pull/42";

async function main(): Promise<void> {
  console.log("1. the console proves who; the approval page proves what");
  const deploy = spokenInstruction({
    utterance: "deploy Alpha to production", needsApproval: true,
  });
  deploy.executes === false && deploy.raises === "approval"
    ? ok(`"deploy Alpha to production" raises an approval and does not run: "${deploy.say}"`)
    : bad(`spoken deploy: ${JSON.stringify(deploy)}`);
  deploy.say.includes("sign in again")
    ? ok("and says it needs re-authentication on the approval page")
    : bad("the re-auth requirement is not stated");
  /*
   * Both halves: an ordinary request still becomes work, or the rule is just
   * "the voice channel does nothing".
   */
  const ordinary = spokenInstruction({ utterance: "what did maintenance do?", needsApproval: false });
  ordinary.raises === "task" && ordinary.executes === false
    ? ok("while an ordinary request queues as a task, on the same path as WhatsApp")
    : bad(`ordinary: ${JSON.stringify(ordinary)}`);
  /*
   * There is no argument that makes a spoken utterance execute. Asserted on the
   * returned shape, because that survives somebody adding a branch later.
   */
  [deploy, ordinary].every((o) => o.executes === false)
    ? ok("nothing spoken on a browser call executes, whatever it was")
    : bad("A VOICE UTTERANCE EXECUTED");

  console.log("");
  console.log("2. the orb is honest");
  const speaking = orbState({ micAmplitude: 0.7, playbackLevel: 0, track: "listening" });
  speaking.state === "listening" && speaking.motion === 0.7
    ? ok("while he speaks, the motion is his microphone amplitude")
    : bad(`speaking: ${JSON.stringify(speaking)}`);
  const answering = orbState({ micAmplitude: 0, playbackLevel: 0.5, track: "answering" });
  answering.state === "answering" && answering.motion === 0.5
    ? ok("while Jarvis speaks, it is the playback level")
    : bad(`answering: ${JSON.stringify(answering)}`);
  /*
   * "Mute the mic -> amplitude-driven motion stops." Not a special case: a muted
   * mic contributes no amplitude, so the same rule produces stillness.
   */
  const muted = orbState({ micAmplitude: 0, playbackLevel: 0, track: "listening" });
  muted.motion === 0
    ? ok("a muted microphone stops the motion, by the same rule rather than a special case")
    : bad(`muted orb still moves: ${JSON.stringify(muted)}`);
  /*
   * "Force the tool track to run 30s -> the orb shows thinking/handed-over, NOT A
   * DECORATIVE SPIN."
   */
  const thinking = orbState({ micAmplitude: 0, playbackLevel: 0, track: "thinking" });
  thinking.state === "thinking" && thinking.motion === 0
    ? ok("a long-running tool shows thinking, with no motion — the state is the signal")
    : bad(`thinking orb: ${JSON.stringify(thinking)}`);
  const idle = orbState({ micAmplitude: 0, playbackLevel: 0, track: null });
  idle.state === "idle" && idle.motion === 0
    ? ok("and an idle call is still, because nothing is happening")
    : bad("an idle call animates, which is a fake progress indicator");
  /*
   * THE STRUCTURAL HALF. A mocked frame proves one frame; this proves the
   * function has nothing to animate on. `orbState.length === 1` and its only
   * argument carries no clock, so "it never moves because time passed" cannot be
   * written here at all.
   */
  const signature = orbState.toString();
  !/Date|now\(|elapsed|timer|frame|tick/i.test(signature)
    ? ok("and the function has no clock, elapsed time, timer or frame counter in scope")
    : bad("orbState can see time passing, so a decorative pulse is one edit away");
  orbState({ micAmplitude: 2, playbackLevel: -1, track: "listening" }).motion === 1
    ? ok("signals outside 0..1 are clamped rather than trusted")
    : bad("an out-of-range amplitude was passed through");

  console.log("");
  console.log("3. the screen is the divergence, and the URL is still not spoken");
  const delivery = deliverInBrowser(`The change is ready. Open ${PR_URL} to review.`);
  !delivery.say.includes("http") && !delivery.say.includes("github.test")
    ? ok("the spoken line still carries no address — S39 is unchanged")
    : bad(`THE URL WAS SPOKEN: ${delivery.say}`);
  delivery.onScreen.includes(PR_URL)
    ? ok("the link goes to the thread beside the orb")
    : bad(`onScreen: ${JSON.stringify(delivery.onScreen)}`);
  delivery.say.includes("on screen")
    ? ok(`and the spoken line says so: "${delivery.say}"`)
    : bad(`the promise is missing: ${delivery.say}`);
  /*
   * Removing the WhatsApp sentence consumes its separator, so the sentence before
   * it can lose its full stop - and a synthesiser then runs the two together.
   */
  !/review I/.test(delivery.say)
    ? ok("and the sentence before the removed promise keeps its full stop")
    : bad(`two sentences ran together: ${delivery.say}`);
  /*
   * "Jarvis says I've put it on screen RATHER THAN I'm sending it to WhatsApp."
   * Saying both would send him looking in two places for one link, and the place
   * he is already looking at has it.
   */
  !delivery.say.includes("WhatsApp")
    ? ok("and does not also promise WhatsApp, which would be two places for one link")
    : bad(`it promised both: ${delivery.say}`);
  const plain = deliverInBrowser("The deploy finished. Nothing needs you.");
  plain.onScreen.length === 0 && !plain.say.includes("on screen")
    ? ok("while a line with no link promises nothing and puts nothing there")
    : bad(`a plain line produced ${JSON.stringify(plain)}`);

  console.log("");
  console.log("4. a dead button is not an option");
  transportFallback({ micGranted: true, webrtcAvailable: true }).mode === "live"
    ? ok("with a microphone and a working transport, the call goes live")
    : bad("a working browser did not get a live call");
  const denied = transportFallback({ micGranted: false, webrtcAvailable: true });
  denied.mode === "one_shot" && denied.say.includes("record a message")
    ? ok(`a denied microphone falls back to the one-shot composer: "${denied.say}"`)
    : bad(`denied mic: ${JSON.stringify(denied)}`);
  const broken = transportFallback({ micGranted: true, webrtcAvailable: false });
  broken.mode === "one_shot" && broken.say.includes("won't connect")
    ? ok("and a browser that cannot hold a call says which of the two failed")
    : bad(`broken transport: ${JSON.stringify(broken)}`);
  denied.say !== broken.say
    ? ok("the two failures are told apart, because the fixes are different")
    : bad("both failures give the same message");

  console.log("");
  console.log("5. persist first, or the call can lose an utterance");
  /*
   * "Ending or dropping the call loses nothing." Asserted by ORDER: the model is
   * asked only after the event exists, and a model call that throws must not
   * unmake the capture.
   */
  const order: string[] = [];
  const result = await captureThenAsk(
    async () => { order.push("persist"); return "inbox-1"; },
    async (id) => { order.push(`ask:${id}`); return "answer"; },
  );
  order.join(" -> ") === "persist -> ask:inbox-1"
    ? ok("the inbox event is written before any model is asked")
    : bad(`order: ${order.join(" -> ")}`);
  result.inboxEventId === "inbox-1"
    ? ok("and the model is told which event it is answering")
    : bad("the model call does not carry the event id");
  const dropped: string[] = [];
  let threw = false;
  try {
    await captureThenAsk(
      async () => { dropped.push("persist"); return "inbox-2"; },
      async () => { throw new Error("tab closed mid-utterance"); },
    );
  } catch { threw = true; }
  threw && dropped.join("") === "persist"
    ? ok("and a call that drops mid-utterance still leaves the captured event behind")
    : bad("a dropped call lost the capture");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  process.exit(1);
});
