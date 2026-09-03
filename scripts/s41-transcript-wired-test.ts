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
  let secondArtifact: string | null = null;
  let secondCall = "";
  let project = "";
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
    console.log("2. the stamp follows what the call actually touched");
    /*
     * The assertion that proves the WIRING rather than the rule. A second call
     * has a real confidential project in its discussed list, so if finalizeCall
     * reads that list and passes it through, the artifact comes out
     * `confidential` rather than the fail-closed `restricted`.
     *
     * The first version seeded a random uuid and asserted the column afterwards -
     * which could not fail, because finalizeCall writes the same list back and a
     * neutered write leaves it identical. Sabotage found that.
     */
    secondCall = `${CCID}-b`;
    project = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','confidential') RETURNING id`, [`${CCID}-p`])).rows[0].id;
    await pool.query(
      `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state, started_at, turns,
                          discussed_projects)
       VALUES ($1,$1,'+15550000222','listening', now(), 1, ARRAY[$2::uuid])`,
      [secondCall, project]);
    secondArtifact = await finalizeCall(pool, secondCall, "hangup");
    const stamped = (await pool.query<{ confidentiality: string | null }>(
      `SELECT confidentiality FROM artifacts WHERE id = $1`, [secondArtifact])).rows[0];
    stamped?.confidentiality === "confidential"
      ? ok("a call that touched a confidential project stamps its transcript confidential")
      : bad(`THE CALL'S OWN EVIDENCE WAS NOT PASSED THROUGH: stamp is ${stamped?.confidentiality}`);
    /*
     * And both directions, or this proves only that everything is restricted:
     * the first call, which touched nothing, stamped restricted above.
     */
    stamped?.confidentiality !== row.confidentiality
      ? ok("while the call that touched nothing stamped differently, so the stamp is not a constant")
      : bad("both calls stamped the same, so the evidence changes nothing");

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
    /*
     * The exact path, not a LIKE. The second call's id extends the first's, so a
     * prefix match counted both and reported a duplicate that was not one -
     * which is the same prefix mistake the desktop allowlist test guards against,
     * arriving in a test rather than in a boundary.
     */
    Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM artifacts WHERE path = $1`,
      [`phone/transcript-${CCID}.md`])).rows[0].n) === 1
      ? ok("and exactly one transcript exists for the call")
      : bad("more than one transcript artifact");
  } finally {
    /*
     * The call row REFERENCES the artifact, so the call goes first. Ordering
     * teardown by the foreign keys rather than by the order things were created
     * is a lesson this repo has already paid for once.
     */
    await pool.query(`DELETE FROM calls WHERE call_control_id = ANY($1)`, [[CCID, secondCall]]);
    for (const a of [artifactId, secondArtifact].filter(Boolean)) {
      await pool.query(`DELETE FROM artifacts WHERE id = $1`, [a]);
    }
    if (project) await pool.query(`DELETE FROM projects WHERE id = $1`, [project]);
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
