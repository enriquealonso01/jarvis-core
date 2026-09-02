/**
 * S23, live: place exactly ONE outbound call and print the webhook trail.
 *
 * Deliberately not the sweep. `sweepOutboundCalls` walks every reason it finds
 * and dials each — which is how the first live attempt produced two calls in one
 * second, the second stopped only by Telnyx's channel limit rather than by
 * anything Jarvis did (§17, recorded in DEBUG_NOTES). When the point is to ring
 * the phone once and watch what comes back, the sweep is the wrong instrument.
 *
 * `placeCall` is still the function under test — the same one the sweep calls —
 * so this narrows WHICH call goes out without faking how it goes out.
 *
 * Usage: s23-place-one.ts <outbound_calls.id>
 */
import { createPool } from "../src/db.js";
import { placeCall } from "../src/outbound.js";

const pool = createPool();

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error("usage: s23-place-one.ts <outbound_calls.id>");

  const before = await pool.query<{ reason: string; state: string; attempts: number; subject: string }>(
    "SELECT reason, state, attempts, subject FROM outbound_calls WHERE id = $1", [id]);
  if (!before.rows[0]) throw new Error(`no outbound call ${id}`);
  console.log(`row: ${before.rows[0].reason} / ${before.rows[0].state} / attempts=${before.rows[0].attempts}`);
  console.log(`subject: ${before.rows[0].subject}`);

  /*
   * `placeCall` refuses when attempts > 0 — the "never redial in a loop" rule
   * enforced by there being no retry path at all. Re-testing therefore needs the
   * attempt counter cleared, which is a deliberate act and not something the
   * system does to itself.
   */
  await pool.query(
    `UPDATE outbound_calls SET state = 'wanted', blocked_reason = NULL, attempts = 0,
            retry_after = NULL, call_control_id = NULL, placed_at = NULL, ended_at = NULL
     WHERE id = $1`, [id]);

  const result = await placeCall(pool, id);
  console.log(`\nplaceCall -> placed=${result.placed} detail=${result.detail}`);

  const after = await pool.query<{ state: string; call_control_id: string | null }>(
    "SELECT state, call_control_id FROM outbound_calls WHERE id = $1", [id]);
  console.log(`row now: ${after.rows[0].state} ccid=${after.rows[0].call_control_id}`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
