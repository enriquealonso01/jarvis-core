/**
 * S41, wired: a real call's transcript is classified when the call ends.
 *
 * The rule and its mechanism shipped with S41 and nothing called them. This is
 * the half that makes the leak actually closed rather than describable:
 *
 *   "S24 stores every call's transcript. A call where a confidential document was
 *    discussed produces a transcript **containing that discussion**, stored under
 *    ordinary retention, indexed by S30, and reachable by any future recall —
 *    including by voice."
 *
 * So this drives `finalizeCall` — the real one — and asserts on the artifact row
 * it wrote. Asserting that `stampTranscript` works was S41's job; asserting that
 * the call path CALLS it is this one's, and the difference is the whole reason
 * "not built: nothing calls this" kept appearing in the evidence.
 *
 * The stamp is `restricted` today because `calls.discussed_projects` is empty —
 * nothing yet records what a call touched. That is the fail-closed answer S41
 * asks for and it is asserted as such, not as a placeholder: "a call whose
 * subject nobody recorded is not a call to read back aloud on the strength of
 * that absence."
 */
import { createPool } from "../src/db.js";
import { finalizeCall } from "../src/callcontrol.js";
import { mayReadAloud } from "../src/voicerecall.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const CCID = `s41w-${Math.random().toString(36).slice(2, 8)}`;

async function main(): Promise<void> {
  let artifactId: string | null = null;
  try {
    await pool.query(
      `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state, started_at, turns)
       VALUES ($1,$1,'+15550000111','listening', now(), 2)`, [CCID]);

    console.log("1. ending a real call classifies its transcript");
    artifactId = await finalizeCall(pool, CCID, "hangup");
    artifactId
      ? ok("finalizeCall wrote a transcript artifact")
      : bad("no transcript artifact was written");

    const row = (await pool.query<{ confidentiality: string | null; path: string }>(
      `SELECT confidentiality, path FROM artifacts WHERE id = $1`, [artifactId])).rows[0];
    row?.confidentiality !== null && row?.confidentiality !== undefined
      ? ok(`and stamped it: ${row.confidentiality}`)
      : bad("THE TRANSCRIPT WAS LEFT UNCLASSIFIED — the leak S41 describes");

    /*
     * `restricted` because nothing records what a call discussed yet. Asserted as
     * the fail-closed answer rather than accepted as a placeholder: absence is
     * not permission.
     */
    row.confidentiality === "restricted"
      ? ok("restricted, because nothing yet records what the call touched and absence is not permission")
      : bad(`expected the fail-closed stamp, got ${row.confidentiality}`);
    !mayReadAloud(row.confidentiality as "restricted")
      ? ok("so a later voice recall will not synthesise it")
      : bad("the stamped transcript would still be read aloud");

    console.log("");
    console.log("2. the evidence is written beside the stamp");
    const call = (await pool.query<{ discussed: string[] | null }>(
      `SELECT discussed_projects AS discussed FROM calls WHERE call_control_id = $1`,
      [CCID])).rows[0];
    Array.isArray(call.discussed)
      ? ok(`calls.discussed_projects is recorded (${call.discussed.length} projects today)`)
      : bad("the evidence column was not written");

    console.log("");
    console.log("3. a second hangup does not write a second transcript");
    /*
     * finalizeCall is idempotent by design - "a second hangup event for the same
     * call must not produce a second transcript that supersedes nothing" - and
     * the stamping must not break that.
     */
    const again = await finalizeCall(pool, CCID, "hangup");
    again === artifactId
      ? ok("the same artifact comes back, so stamping did not make it write twice")
      : bad(`a second transcript was written: ${again}`);
    Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM artifacts WHERE path LIKE $1`,
      [`phone/transcript-${CCID}%`])).rows[0].n) === 1
      ? ok("and exactly one transcript exists for the call")
      : bad("more than one transcript artifact");
  } finally {
    /*
     * The call row REFERENCES the artifact, so the call goes first. Ordering
     * teardown by the foreign keys rather than by the order things were created
     * is a lesson this repo has already paid for once.
     */
    await pool.query(`DELETE FROM calls WHERE call_control_id = $1`, [CCID]);
    if (artifactId) await pool.query(`DELETE FROM artifacts WHERE id = $1`, [artifactId]);
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
