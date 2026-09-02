/**
 * The restart, for S19's mid-call test.
 *
 * Deliberately a whole separate process: it shares no module state with the
 * suite that spawned it, which is exactly what an API restart leaves behind.
 * It sends one more transcription for a call that is already mid-answer and
 * prints what the handler decided. With the turn gate in a module-level Map
 * this printed an answer; with it in the row, it prints a refusal.
 */
import { createPool } from "../src/db.js";
import { handleCallEvent } from "../src/callcontrol.js";

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
console.log(verdict);
await pool.end().catch(() => undefined);
