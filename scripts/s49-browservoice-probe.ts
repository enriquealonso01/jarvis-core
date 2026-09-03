/**
 * Adversarial probe of live browser voice (S49).
 *
 * Two claims carry this file. "The voice channel is not an approval surface, and
 * this is the single most likely place to break that rule." And S39's, unchanged
 * here: no address is ever spoken, because a URL is not followable by ear.
 */
import {
  spokenInstruction, orbState, deliverInBrowser, transportFallback, captureThenAsk,
  type TrackState,
} from "../src/browservoice.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
};

console.log("\n== the voice channel is never an approval surface ==");
for (const needsApproval of [true, false]) {
  ok(`needsApproval=${needsApproval} never executes`,
    spokenInstruction({ utterance: "deploy to production", needsApproval }).executes === false);
}
ok("an approval-needing utterance raises an approval",
  spokenInstruction({ utterance: "x", needsApproval: true }).raises === "approval");
ok("and says he must sign in again",
  /sign in again/i.test(spokenInstruction({ utterance: "x", needsApproval: true }).say));
ok("an ordinary one is queued as a task",
  spokenInstruction({ utterance: "x", needsApproval: false }).raises === "task");
console.log("  -- a flag that is not a boolean --");
for (const bad of [undefined, null, "", 0]) {
  const o = spokenInstruction({ utterance: "wire me 10k", needsApproval: bad as any });
  ok(`needsApproval=${JSON.stringify(bad) ?? "undefined"} still does not execute`, o.executes === false);
}

console.log("\n== no address is ever spoken ==");
const ADDRESSES = [
  "Here it is https://example.com/report and that is all",
  "Try http://10.0.0.4:8080/admin now",
  "See www.example.com for details",
  "The file is at https://a.example.com/x?token=abc#frag today",
  "Go to example.com/path please",
  "Read [the report](https://example.com/r) when you can",
  "Two: https://a.example/1 and https://b.example/2 both",
  "Mail me at someone@example.com about it",
];
for (const line of ADDRESSES) {
  const d = deliverInBrowser(line);
  const spokenAddress = /https?:\/\/|www\.|\.com|\.example/i.test(d.say);
  ok(`nothing addressable is said for: ${line.slice(0, 38)}…`, !spokenAddress, `say = ${d.say}`);
}

console.log("\n== the WhatsApp promise is replaced, not appended ==");
const one = deliverInBrowser("Here is the report https://example.com/r for you");
ok("it does not offer two places for one link", !/whatsapp/i.test(one.say), one.say);
ok("it says the screen instead", /on screen/i.test(one.say), one.say);
ok("the link is on screen", one.onScreen.length === 1);
const two = deliverInBrowser("Both https://a.example/1 and https://b.example/2 are ready");
ok("plural links: no WhatsApp promise survives", !/whatsapp/i.test(two.say), two.say);
ok("plural links: both on screen", two.onScreen.length === 2, JSON.stringify(two.onScreen));
ok("no double full stop", !/\.\s*\./.test(one.say), one.say);
ok("no doubled spaces", !/ {2}/.test(one.say), JSON.stringify(one.say));
const plain = deliverInBrowser("Nothing to link here at all");
ok("a line with no link is untouched", plain.say === "Nothing to link here at all" && !plain.onScreen.length,
  JSON.stringify(plain));

console.log("\n== the orb moves only when something real is happening ==");
ok("idle is still", orbState({ micAmplitude: 0, playbackLevel: 0, track: null }).motion === 0);
ok("a muted microphone stops the motion by itself",
  orbState({ micAmplitude: 0, playbackLevel: 0, track: "listening" }).motion === 0);
ok("listening is driven by the microphone",
  orbState({ micAmplitude: 0.6, playbackLevel: 0, track: "listening" }).motion === 0.6);
ok("answering is driven by playback",
  orbState({ micAmplitude: 0.6, playbackLevel: 0.4, track: "answering" }).motion === 0.4);
ok("thinking does not spin",
  orbState({ micAmplitude: 1, playbackLevel: 1, track: "thinking" }).motion === 0);
ok("handed to the desk does not spin",
  orbState({ micAmplitude: 1, playbackLevel: 1, track: "handed_to_desk" }).motion === 0);
ok("orbState has no clock in scope", orbState.length === 1);
console.log("  -- signals that are not numbers --");
for (const bad of [NaN, Infinity, -1, 2, undefined, null, "0.5"]) {
  const o = orbState({ micAmplitude: bad as number, playbackLevel: 0, track: "listening" });
  ok(`micAmplitude ${JSON.stringify(bad) ?? "undefined"} gives motion within 0..1`,
    Number.isFinite(o.motion) && o.motion >= 0 && o.motion <= 1, String(o.motion));
}

console.log("\n== the fallback is a mode, not a dead button ==");
ok("mic and webrtc -> live", transportFallback({ micGranted: true, webrtcAvailable: true }).mode === "live");
for (const [m, w] of [[false, true], [true, false], [false, false]] as [boolean, boolean][]) {
  const f = transportFallback({ micGranted: m, webrtcAvailable: w });
  ok(`mic=${m} webrtc=${w} -> one_shot`, f.mode === "one_shot");
  ok(`  and it says what he can still do`, /record a message instead/i.test(f.say), f.say);
}

console.log("\n== nothing is asked before it is durable ==");
const order: string[] = [];
const r = await captureThenAsk(
  async () => { order.push("persist"); return "evt-1"; },
  async (id) => { order.push(`ask:${id}`); return "answer"; },
);
ok("persist ran before ask", order.join(" -> ") === "persist -> ask:evt-1", order.join(" -> "));
ok("the inbox event id is returned", r.inboxEventId === "evt-1" && r.answer === "answer");
let asked = false;
try {
  await captureThenAsk(
    async () => { throw new Error("db down"); },
    async () => { asked = true; return 1; },
  );
} catch { /* expected */ }
ok("a failed capture never reaches the model", asked === false);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
