/**
 * The restart, for S19's mid-call test.
 *
 * Deliberately a whole separate process: it shares no module state with the
 * suite that spawned it, which is exactly what an API restart leaves behind. It
 * sends one more utterance for a call that is already mid-answer and prints what
 * the handler decided, plus every command it issued.
 *
 * With the turn state in a module-level Map this process saw a call it had never
 * heard of and answered over the reply already playing. With it in the row, it
 * sees a call that is speaking and does what a person would: stops the playback
 * and lets the caller talk.
 */
import { createPool } from "../src/db.js";
import { handleCallEvent, sentCommands } from "../src/callcontrol.js";

const pool = createPool();
const ccid = process.argv[2];

const verdict = await handleCallEvent(pool, {
  data: {
    event_type: "call.transcription",
    payload: {
      call_control_id: ccid,
      from: "+15551234567",
      transcription_data: { transcript: "and another thing", is_final: true },
    },
  },
});
console.log(`verdict: ${verdict}`);
console.log(`actions: ${sentCommands.map((c) => c.action).join(",")}`);
await pool.end().catch(() => undefined);
