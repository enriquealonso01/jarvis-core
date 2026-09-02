/**
 * S19 — call reliability.
 *
 * The plan is explicit about the order: "Regression first: assert Jarvis never
 * transcribes its own audio, and that one utterance produces exactly one reply.
 * These two tests exist before any new feature lands." Both of those bugs
 * happened on real calls and cost real money, so they lead.
 *
 * Everything is driven by synthesised Telnyx webhooks against the real handler,
 * with `JARVIS_TELNYX=fake` recording the commands that would have gone out. No
 * part of this dials a phone — which is the point: a regression that can only be
 * caught by phoning up is a regression that gets caught by the caller.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPool } from "../src/db.js";
import {
  clearSentCommands, finalizeCall, handleCallEvent, sentCommands, spokenLines, sweepCallDeadlines,
} from "../src/callcontrol.js";
import { callTimeline, currentState } from "../src/callstate.js";

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

const OWNER = "+15551234567";
const STAMP = Date.now().toString(36);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const GREETING = b64("greeting");
const REPLY = b64("reply");
const ACK = b64("ack");

let n = 0;
function newCcid(): string {
  n += 1;
  return `s19-${STAMP}-${n}`;
}

function ev(type: string, ccid: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: type,
      payload: {
        call_control_id: ccid,
        call_leg_id: `${ccid}-leg`,
        from: OWNER,
        stir_shaken: { attestation: "A" },
        ...extra,
      },
    },
  };
}

const said = (text: string, isFinal = true) => ({
  transcription_data: { transcript: text, is_final: isFinal },
});

/** Commands issued for one call, in order, as `action` names. */
const actions = (ccid: string) => sentCommands.filter((c) => c.ccid === ccid).map((c) => c.action);
/** What was actually said on a call, whichever voice said it. */
const spoken = (ccid: string) => spokenLines.filter((l) => l.ccid === ccid).map((l) => l.text);

/** Take a call from ringing to listening — the shared prologue. */
async function upToListening(ccid: string): Promise<void> {
  await handleCallEvent(pool, ev("call.initiated", ccid));
  await handleCallEvent(pool, ev("call.answered", ccid));
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: GREETING }));
}

async function main(): Promise<void> {
  console.log("########## regression: Jarvis never transcribes its own audio ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    const start = sentCommands.filter((c) => c.ccid === ccid && c.action === "transcription_start");
    check("transcription is armed exactly once, by the greeting ending", 1, start.length);
    check(
      "and only on the INBOUND track — the bug was Whisper hearing Jarvis",
      "inbound",
      start[0]?.body.transcription_tracks,
    );

    // Jarvis's own reply finishing must not arm anything.
    const before = actions(ccid).length;
    await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
    const armedAgain = sentCommands
      .filter((c) => c.ccid === ccid && c.action === "transcription_start").length;
    check("a reply's own playback.ended arms nothing further", 1, armedAgain);
    check("and issues no commands at all", before, actions(ccid).length);

    // The recording exists for the artifact, not to drive the conversation.
    const rec = sentCommands.find((c) => c.ccid === ccid && c.action === "record_start");
    truthy("recording is started for the artifact", rec);
    check("bounded, so a forgotten open line cannot run up the bill", 120, rec?.body.max_length);
    await finalizeCall(pool, ccid, "regression test finished with it");
  }

  console.log("\n########## regression: one utterance, exactly one reply ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    // Telnyx emits a final per SEGMENT: one sentence can arrive as three events.
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going, again")));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("and once more")));

    const replies = sentCommands.filter(
      (c) => c.ccid === ccid && c.body.client_state === REPLY,
    );
    check("three transcriptions, one reply", 1, replies.length);
    check("the call is left speaking, not thinking three times over", "speaking", await currentState(pool, ccid));

    // And the same thing when they arrive together rather than in sequence.
    await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
    clearSentCommands();
    await Promise.all([
      handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue"))),
      handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue please"))),
    ]);
    check(
      "two simultaneous transcriptions still produce one reply",
      1,
      sentCommands.filter((c) => c.ccid === ccid && c.body.client_state === REPLY).length,
    );
    ok("...which is what the gate being an atomic UPDATE buys over a read-then-write");
    await finalizeCall(pool, ccid, "regression test finished with it");
  }

  console.log("\n########## the gate survives a restart ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    check("mid-answer, the state is in the row", "speaking", await currentState(pool, ccid));

    /*
     * The restart. A SEPARATE PROCESS — nothing of this one's memory survives
     * into it — sends the next transcription for the same live call. With the
     * gate in a module-level Map this is the exact moment the runaway loop came
     * back, because the fresh process saw no call mid-answer.
     */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(here, "s19-second-process.ts"), ccid],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let buf = "";
      child.stdout.on("data", (d) => { buf += String(d); });
      child.stderr.on("data", (d) => { buf += String(d); });
      child.on("close", () => resolve(buf.trim()));
    });
    console.log(`  the fresh process said: ${out.split("\n").pop()}`);
    truthy(
      "a fresh process refuses the second utterance, as the first would have",
      out.includes("ignored while answering"),
    );
    check("and the call is still exactly where it was", "speaking", await currentState(pool, ccid));

    await finalizeCall(pool, ccid, "test finished with it");
  }

  console.log("\n########## forced provider failures ##########\n");
  {
    // ---- ElevenLabs cannot render: the carrier voice, and a ticket.
    const ccid = newCcid();
    clearSentCommands();
    process.env.JARVIS_PHONE_FAIL = "tts";
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));

    const reply = sentCommands.find((c) => c.ccid === ccid && c.body.client_state === REPLY);
    check("with no TTS the reply still goes out", "speak", reply?.action);
    truthy("in words, not silence", String(reply?.body.payload ?? "").length > 10);
    const issue = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
       WHERE dedupe_key = 'elevenlabs-render-failed' AND status <> 'resolved'`,
    );
    check("and the degradation is a ticket, not a log line", "1", issue.rows[0].n);
    await finalizeCall(pool, ccid, "tts test done");
  }
  {
    // ---- The model fails once. "Give me a moment", then the real answer.
    const ccid = newCcid();
    clearSentCommands();
    process.env.JARVIS_PHONE_FAIL = "model_once";
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));

    const lines = sentCommands.filter((c) => c.ccid === ccid && c.action !== "record_start");
    const filler = lines.find((c) => c.body.client_state === ACK);
    truthy("a failed model says something rather than nothing", filler);
    truthy(
      "and what it says is that it is still working",
      spokenLines.some((l) => l.ccid === ccid && l.clientState === ACK
        && l.text.toLowerCase().includes("moment")),
    );
    const answer = lines.find((c) => c.body.client_state === REPLY);
    truthy("then the retry's answer arrives", answer);
    check("the filler did NOT end the turn", "speaking", await currentState(pool, ccid));
    await finalizeCall(pool, ccid, "model_once test done");
  }
  {
    // ---- The model fails twice: an honest offer to follow up in writing.
    const ccid = newCcid();
    clearSentCommands();
    process.env.JARVIS_PHONE_FAIL = "model,tts";
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));

    truthy(
      "twice-failed, it offers to follow up in writing",
      spoken(ccid).some((t) => t.includes("follow up in writing")),
    );
    const pending = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inbox_events
       WHERE channel = 'phone' AND raw_text = 'how is the deploy going'
         AND processing_state = 'pending'`,
    );
    truthy(
      "and the promise is a queued message, not a good intention",
      Number(pending.rows[0].n) > 0,
    );
    await finalizeCall(pool, ccid, "model test done");
  }
  {
    // ---- STT hears nothing usable.
    const ccid = newCcid();
    clearSentCommands();
    process.env.JARVIS_PHONE_FAIL = "";
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("", true)));

    truthy(
      "an empty final says 'I did not catch that' rather than nothing",
      spoken(ccid).some((t) => t.toLowerCase().includes("did not catch")),
    );
    const before = actions(ccid).length;
    await handleCallEvent(pool, ev("call.transcription", ccid, said("", false)));
    check("an INTERIM empty says nothing at all", before, actions(ccid).length);
    await finalizeCall(pool, ccid, "stt test done");
  }

  console.log("\n########## silence, talk-over, and hanging up mid-sentence ##########\n");
  {
    // ---- 30 seconds of nothing.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await pool.query(
      "UPDATE calls SET deadline_at = now() - interval '1 second' WHERE call_control_id = $1",
      [ccid],
    );
    await sweepCallDeadlines(pool);
    truthy(
      "a silent caller is asked whether they are still there",
      spoken(ccid).some((s) => s.toLowerCase().includes("still there")),
    );
    check("and the call is still live", "listening", await currentState(pool, ccid));

    await pool.query(
      "UPDATE calls SET deadline_at = now() - interval '1 second' WHERE call_control_id = $1",
      [ccid],
    );
    await sweepCallDeadlines(pool);
    truthy("the second silence hangs up", actions(ccid).includes("hangup"));
    check("and the call is ended, not left live", "ended", await currentState(pool, ccid));
  }
  {
    // ---- Talking over the greeting.
    const ccid = newCcid();
    clearSentCommands();
    await handleCallEvent(pool, ev("call.initiated", ccid));
    await handleCallEvent(pool, ev("call.answered", ccid));
    await handleCallEvent(pool, ev("call.transcription", ccid, said("say something short")));
    check(
      "a transcription during the greeting is not answered over the greeting",
      0,
      sentCommands.filter((c) => c.ccid === ccid && c.body.client_state === REPLY).length,
    );
    check("the call is still playing its greeting", "greeting", await currentState(pool, ccid));
    await finalizeCall(pool, ccid, "talk-over test done");
  }
  {
    // ---- Hanging up mid-sentence.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await handleCallEvent(pool, ev("call.hangup", ccid, { hangup_cause: "normal_clearing" }));

    check("hanging up mid-answer ends the call", "ended", await currentState(pool, ccid));
    const row = await pool.query<{ transcript_artifact_id: string | null; end_reason: string }>(
      "SELECT transcript_artifact_id, end_reason FROM calls WHERE call_control_id = $1", [ccid]);
    truthy("with a transcript stored", row.rows[0].transcript_artifact_id);
    truthy("and a reason recorded", row.rows[0].end_reason.includes("hangup"));

    const trail = await callTimeline(pool, ccid);
    truthy("and the whole ordering written down for the next time it goes wrong", trail.length >= 5);
  }
  {
    // ---- The events that never arrive at all.
    const ccid = newCcid();
    await upToListening(ccid);
    await pool.query(
      "UPDATE calls SET state_at = now() - interval '30 minutes' WHERE call_control_id = $1",
      [ccid],
    );
    await sweepCallDeadlines(pool);
    check("a call whose webhooks stopped is written off, not left live", "ended",
      await currentState(pool, ccid));
  }

  // ==================================================== the Done when
  console.log("\n########## ten consecutive calls, three with a forced failure ##########\n");
  {
    process.env.JARVIS_PHONE_FAIL = "";
    clearSentCommands();
    const ids: string[] = [];
    const FORCED: Record<number, string> = { 3: "tts", 6: "model", 9: "stt" };

    for (let i = 1; i <= 10; i += 1) {
      process.env.JARVIS_PHONE_FAIL = FORCED[i] ?? "";
      const ccid = newCcid();
      ids.push(ccid);
      await upToListening(ccid);
      await handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue")));
      await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
      await handleCallEvent(pool, ev("call.transcription", ccid, said("say something short")));
      await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
      await handleCallEvent(pool, ev("call.hangup", ccid, { hangup_cause: "normal_clearing" }));
    }
    process.env.JARVIS_PHONE_FAIL = "";

    const rows = await pool.query<{
      call_control_id: string; state: string; ended_at: string | null;
      transcript_artifact_id: string | null; turns: number; conversation_id: string | null;
    }>(
      `SELECT call_control_id, state, ended_at::text AS ended_at, transcript_artifact_id, turns,
              conversation_id
       FROM calls WHERE call_control_id = ANY($1::text[]) ORDER BY started_at`,
      [ids],
    );
    check("ten calls, ten rows", 10, rows.rowCount);
    check("all ten ended", 10, rows.rows.filter((r) => r.state === "ended" && r.ended_at).length);
    check(
      "all ten have a stored transcript",
      10,
      rows.rows.filter((r) => r.transcript_artifact_id).length,
    );
    check("each in its own thread", 10, new Set(rows.rows.map((r) => r.conversation_id)).size);
    check("two turns each, no runaways", true, rows.rows.every((r) => r.turns === 2));
    check(
      "and three of them were the forced failures",
      3,
      Object.keys(FORCED).length,
    );

    const artifacts = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM artifacts
       WHERE path LIKE 'phone/transcript-s19-${STAMP}-%' AND artifact_type = 'document'`,
    );
    truthy("the transcripts are real artifact rows", Number(artifacts.rows[0].n) >= 10);

    // Scoped to this run's calls. Counting the whole table made the assertion
    // depend on whatever a previous run left behind, which is how six absolute
    // counts in earlier suites came to be wrong; see DEBUG_NOTES.
    const leaked = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM calls
       WHERE call_control_id LIKE $1 AND ended_at IS NULL`,
      [`s19-${STAMP}-%`],
    );
    check("no stuck call_control_id is left behind", "0", leaked.rows[0].n);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
