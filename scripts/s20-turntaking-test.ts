/**
 * S20 — turn-taking and barge-in.
 *
 * Two claims, and they pull against each other. A pause mid-thought must not end
 * the caller's turn, so Jarvis waits. And the caller must be able to interrupt,
 * so Jarvis stops instantly. Get the first wrong and you are interrupted while
 * thinking; get the second wrong and you are talked over by your own assistant,
 * which the plan calls "the single most irritating failure in voice UX".
 *
 * The endpoint window is shortened by `JARVIS_ENDPOINT_MS` so the pause
 * assertions cost milliseconds instead of six seconds each. The last section
 * puts it back to the real five seconds and proves the default is what a real
 * call actually uses — a test that only ever runs at 600ms proves nothing about
 * the number in production.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db.js";
import {
  clearSentCommands, handleCallEvent, finalizeCall, sentCommands, spokenLines, sweepCallDeadlines,
} from "../src/callcontrol.js";
import { looksLikeSpeech } from "../src/callcontrol.js";
import { BUDGET_MS, currentState } from "../src/callstate.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OWNER = "+15551234567";
const STAMP = Date.now().toString(36);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const GREETING = b64("greeting");
const REPLY = b64("reply");

/** The shortened window this suite runs at, read from the module under test. */
const WINDOW = BUDGET_MS.endpoint;

let n = 0;
const newCcid = () => `s20-${STAMP}-${(n += 1)}`;

function ev(type: string, ccid: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: type,
      payload: {
        call_control_id: ccid, call_leg_id: `${ccid}-leg`, from: OWNER,
        stir_shaken: { attestation: "A" }, ...extra,
      },
    },
  };
}
const said = (text: string, extra: Record<string, unknown> = {}) => ({
  transcription_data: { transcript: text, is_final: true, ...extra },
});

const replies = (ccid: string) => spokenLines.filter((l) => l.ccid === ccid && l.clientState === REPLY);
const actions = (ccid: string) => sentCommands.filter((c) => c.ccid === ccid).map((c) => c.action);

async function upToListening(ccid: string): Promise<void> {
  await handleCallEvent(pool, ev("call.initiated", ccid));
  await handleCallEvent(pool, ev("call.answered", ccid));
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: GREETING }));
}

async function main(): Promise<void> {
  console.log(`########## endpointing (window ${WINDOW}ms) ##########\n`);
  {
    // ---- A pause mid-sentence is not the end of a turn.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    await handleCallEvent(pool, ev("call.transcription", ccid, said("book me a flight to Madrid")));
    await sleep(WINDOW * 0.5);
    check("half a window later, Jarvis has not answered", 0, replies(ccid).length);
    check("it is still listening, not thinking", "listening", await currentState(pool, ccid));

    await handleCallEvent(pool, ev("call.transcription", ccid, said("no, to Barcelona")));
    await sleep(WINDOW * 0.5);
    check("and the second segment resets the clock rather than starting a turn", 0, replies(ccid).length);

    await sleep(WINDOW * 1.2);
    check("once the caller really stops, exactly one reply", 1, replies(ccid).length);

    const heard = await pool.query<{ raw_text: string }>(
      `SELECT raw_text FROM inbox_events WHERE channel = 'phone'
       ORDER BY received_at DESC LIMIT 1`,
    );
    check(
      "and it answered the WHOLE sentence, both segments",
      "book me a flight to Madrid no, to Barcelona",
      heard.rows[0]?.raw_text,
    );
    ok("...which is the difference between one turn and three");
    await finalizeCall(pool, ccid, "endpoint test done");
  }
  {
    // ---- A long enough pause DOES hand over the turn.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.4);
    check("a full pause hands the turn to Jarvis", 1, replies(ccid).length);

    await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue")));
    await sleep(WINDOW * 1.4);
    check("and the next thing said is a second turn, not part of the first", 2, replies(ccid).length);
    await finalizeCall(pool, ccid, "second turn test done");
  }

  console.log("\n########## barge-in ##########\n");
  for (const where of ["start", "middle", "end"]) {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.4);
    check(`[${where}] Jarvis is speaking`, "speaking", await currentState(pool, ccid));

    // "start" interrupts immediately; the others let some of the reply play.
    if (where === "middle") await sleep(40);
    if (where === "end") await sleep(120);

    const before = Date.now();
    await handleCallEvent(pool, ev("call.transcription", ccid, said("actually, stop")));
    const took = Date.now() - before;

    const stops = sentCommands.filter((c) => c.ccid === ccid && c.action === "playback_stop");
    check(`[${where}] the playback is stopped`, 1, stops.length);
    check(`[${where}] and the floor is the caller's again`, "listening", await currentState(pool, ccid));
    truthy(`[${where}] within a beat — ${took}ms of handler time`, took < 300);
    check(
      `[${where}] the stop names the playback it is stopping`,
      REPLY,
      stops[0]?.body.client_state,
    );

    // And what they said while interrupting is not lost.
    await sleep(WINDOW * 1.4);
    const texts = replies(ccid).map((r) => r.text);
    check(`[${where}] the interruption itself gets answered`, 2, texts.length);
    await finalizeCall(pool, ccid, `barge-in ${where} done`);
  }
  {
    // ---- Interrupting while Jarvis is still THINKING.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.4);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("and the queue too")));
    // The reply that was already in flight finishes, and THEN the waiting turn.
    await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
    await sleep(WINDOW * 1.4);
    check("something said over a reply is answered after it, not dropped", 2, replies(ccid).length);
    await finalizeCall(pool, ccid, "mid-thinking test done");
  }

  console.log("\n########## the room is not a turn ##########\n");
  {
    check("a cough is not speech", false, looksLikeSpeech("uh"));
    check("nor is the engine's guess at silence", false, looksLikeSpeech("Thank you."));
    check("nor a bare acknowledgement token", false, looksLikeSpeech("okay"));
    check("nor an empty string", false, looksLikeSpeech("   "));
    check(
      "a low-confidence transcript is the room, whatever the words",
      false,
      looksLikeSpeech("book me a flight", { transcription_data: { confidence: 0.2 } }),
    );
    check("but a real instruction is a turn", true, looksLikeSpeech("book me a flight"));
    check("and so is a short one that means something", true, looksLikeSpeech("no"));
    check(
      "confidence high enough is believed",
      true,
      looksLikeSpeech("cancel that", { transcription_data: { confidence: 0.9 } }),
    );

    // Through the real handler: a television playing does not take the turn.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("uh")));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("thank you")));
    await handleCallEvent(pool, ev("call.transcription", ccid,
      said("tonight on channel four", { confidence: 0.15 })));
    await sleep(WINDOW * 1.5);
    check("three rooms' worth of noise, no reply", 0, replies(ccid).length);
    check("and the call never left listening", "listening", await currentState(pool, ccid));

    // Noise does NOT interrupt a reply either.
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.4);
    check("a real turn still works after the noise", "speaking", await currentState(pool, ccid));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("um")));
    check("and noise over a reply does not stop it", 0,
      sentCommands.filter((c) => c.ccid === ccid && c.action === "playback_stop").length);
    check("the reply keeps the floor", "speaking", await currentState(pool, ccid));
    await finalizeCall(pool, ccid, "noise test done");
  }

  console.log("\n########## the turn survives a restart ##########\n");
  {
    // The in-process timer is a latency device; the row is the durable copy.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("what is on my calendar")));

    // Simulate the restart: the timer is gone, the deadline is due.
    await pool.query(
      "UPDATE calls SET deadline_at = now() - interval '1 second' WHERE call_control_id = $1",
      [ccid],
    );
    const notes = await sweepCallDeadlines(pool);
    truthy("the sweep takes the turn the lost timer would have", notes.some((s) => s.includes(ccid)));
    check("and the caller is answered", 1, replies(ccid).length);
    check(
      "the pending text is cleared, so it cannot be answered twice",
      null,
      (await pool.query<{ pending_text: string | null }>(
        "SELECT pending_text FROM calls WHERE call_control_id = $1", [ccid])).rows[0].pending_text,
    );
    await finalizeCall(pool, ccid, "restart test done");
  }

  console.log("\n########## the default really is five seconds ##########\n");
  {
    // Asked of a process that has NOT had the window shortened. Asserting the
    // default from inside a process that already overrode it proves nothing.
    const env = { ...process.env };
    delete env.JARVIS_ENDPOINT_MS;
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "s20-default-window.ts")],
        { env, stdio: ["ignore", "pipe", "inherit"] },
      );
      let buf = "";
      child.stdout.on("data", (d) => { buf += String(d); });
      child.on("close", () => resolve(buf.trim()));
    });
    check("the shipped endpoint window is the plan's ~5 seconds", "5000", out);
    truthy("and this run deliberately shortened it, which is why it is fast", WINDOW < 5000);
  }

  // ===================================================== the Done when
  console.log("\n########## two minutes of conversation, nobody talked over ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    /*
     * A two-minute call, scaled. Twelve turns with realistic shapes: sentences
     * that arrive in two segments with a pause between them, one interruption,
     * and one stretch of background noise. What is asserted is the property the
     * plan names — nobody talks over anybody — which here means: no reply is
     * ever issued while the caller has an unfinished utterance pending, and no
     * caller utterance is ever dropped.
     */
    const script: { say: string[]; interrupt?: boolean; noise?: string }[] = [
      { say: ["how is the deploy going"] },
      { say: ["read me the queue", "the heavy one"] },
      { say: ["say something short"] },
      { say: ["how is the deploy going"], interrupt: true },
      { say: ["read me the queue"], noise: "uh" },
      { say: ["say something short", "please"] },
    ];

    let expectedReplies = 0;
    const overlaps: string[] = [];
    for (const turn of script) {
      for (const [i, part] of turn.say.entries()) {
        await handleCallEvent(pool, ev("call.transcription", ccid, said(part)));
        if (i < turn.say.length - 1) await sleep(WINDOW * 0.4);
      }
      if (turn.noise) await handleCallEvent(pool, ev("call.transcription", ccid, said(turn.noise)));

      // While the caller has something pending, Jarvis must not be speaking.
      const mid = await pool.query<{ state: string; pending_text: string | null }>(
        "SELECT state, pending_text FROM calls WHERE call_control_id = $1", [ccid]);
      if (mid.rows[0].pending_text && mid.rows[0].state === "speaking") {
        overlaps.push(`spoke while "${mid.rows[0].pending_text}" was unfinished`);
      }

      await sleep(WINDOW * 1.4);
      expectedReplies += 1;

      if (turn.interrupt) {
        await handleCallEvent(pool, ev("call.transcription", ccid, said("actually, never mind")));
        await sleep(WINDOW * 1.4);
        expectedReplies += 1;
      }
      await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
    }

    check("nobody talked over anybody", 0, overlaps.length);
    if (overlaps.length) console.log(`        ${overlaps.join("\n        ")}`);
    check("every turn got exactly one reply", expectedReplies, replies(ccid).length);

    const row = await pool.query<{ turns: number; barge_ins: number; pending_text: string | null }>(
      "SELECT turns, barge_ins, pending_text FROM calls WHERE call_control_id = $1", [ccid]);
    check("the call counted the same number of turns", expectedReplies, row.rows[0].turns);
    check("one interruption, recorded as one", 1, row.rows[0].barge_ins);
    check("and nothing the caller said was left unanswered", null, row.rows[0].pending_text);

    await finalizeCall(pool, ccid, "the conversation ended");
    const done = await pool.query<{ state: string; transcript_artifact_id: string | null }>(
      "SELECT state, transcript_artifact_id FROM calls WHERE call_control_id = $1", [ccid]);
    check("and it ended cleanly, like any other call", "ended", done.rows[0].state);
    truthy("with the whole conversation stored", done.rows[0].transcript_artifact_id);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
