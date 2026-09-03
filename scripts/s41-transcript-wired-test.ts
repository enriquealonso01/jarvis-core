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
  let derivedCall = "";
  let derivedArtifact: string | null = null;
  let derivedTask = "";
  let conversationId = "";
  let inboxCall = "";
  let inboxArtifact: string | null = null;
  let inboxEvent = "";
  let conversationId2 = "";
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
    console.log("3. and it derives what the call touched, rather than being told");
    /*
     * THE ASSERTION THIS TICK EXISTS FOR. Nothing seeds discussed_projects here.
     * A task is created in a confidential project on the call's own conversation
     * - which is what actually happens when a call produces work - and the
     * transcript must come out confidential because finalizeCall DERIVED that.
     *
     * A list something had to remember to append to would be wrong on the first
     * call where somebody forgot, and wrong in the permissive direction.
     */
    derivedCall = `${CCID}-c`;
    const conv = (await pool.query<{ id: string }>(
      `INSERT INTO conversations (project_id, title, channel, channels, last_activity_at)
       VALUES (NULL,$1,'phone',ARRAY['phone'],now()) RETURNING id`,
      [`${CCID} derived`])).rows[0].id;
    conversationId = conv;
    await pool.query(
      `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state, started_at, turns,
                          conversation_id)
       VALUES ($1,$1,'+15550000333','listening', now(), 1, $2)`, [derivedCall, conv]);
    derivedTask = (await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, state, priority, lane, conversation_id)
       VALUES ($1,$2,'succeeded','normal','heavy',$3) RETURNING id`,
      [project, `${CCID} work from the call`, conv])).rows[0].id;

    derivedArtifact = await finalizeCall(pool, derivedCall, "hangup");
    const derivedStamp = (await pool.query<{ confidentiality: string | null }>(
      `SELECT confidentiality FROM artifacts WHERE id = $1`, [derivedArtifact])).rows[0];
    derivedStamp?.confidentiality === "confidential"
      ? ok("a call that created work in a confidential project stamps confidential, with nothing seeded")
      : bad(`the derivation did not happen: stamp is ${derivedStamp?.confidentiality}`);
    const evidence = (await pool.query<{ ids: string[] }>(
      `SELECT discussed_projects AS ids FROM calls WHERE call_control_id = $1`,
      [derivedCall])).rows[0];
    evidence.ids.includes(project)
      ? ok("and the project it touched is written down as the evidence for that stamp")
      : bad(`evidence: ${JSON.stringify(evidence.ids)}`);

    /*
     * The OTHER branch of the derivation, and the more common one: a call
     * utterance routed to a project produces an inbox event, not necessarily a
     * task. Sabotage found this untested - the suite only ever created a task, so
     * removing the inbox_events branch changed nothing.
     */
    inboxCall = `${CCID}-d`;
    const conv2 = (await pool.query<{ id: string }>(
      `INSERT INTO conversations (project_id, title, channel, channels, last_activity_at)
       VALUES (NULL,$1,'phone',ARRAY['phone'],now()) RETURNING id`,
      [`${CCID} routed`])).rows[0].id;
    conversationId2 = conv2;
    await pool.query(
      `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state, started_at, turns,
                          conversation_id)
       VALUES ($1,$1,'+15550000444','listening', now(), 1, $2)`, [inboxCall, conv2]);
    inboxEvent = (await pool.query<{ id: string }>(
      `INSERT INTO inbox_events (channel, project_id, conversation_id, raw_text)
       VALUES ('phone',$1,$2,$3) RETURNING id`,
      [project, conv2, `${CCID} something routed to the confidential project`])).rows[0].id;

    inboxArtifact = await finalizeCall(pool, inboxCall, "hangup");
    const routedStamp = (await pool.query<{ confidentiality: string | null }>(
      `SELECT confidentiality FROM artifacts WHERE id = $1`, [inboxArtifact])).rows[0];
    routedStamp?.confidentiality === "confidential"
      ? ok("a call whose utterance was merely ROUTED to a project stamps confidential too")
      : bad(`the inbox-event branch did not count: ${routedStamp?.confidentiality}`);

    console.log("");
    console.log("4. a second hangup does not write a second transcript");
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
     * The exact path, not a LIKE. The later calls' ids extend the first's, so a
     * prefix match counted them and reported a duplicate that was not one - the
     * same prefix mistake the desktop allowlist guards against, arriving in a
     * test rather than in a boundary.
     */
    Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM artifacts WHERE path = $1`,
      [`phone/transcript-${CCID}.md`])).rows[0].n) === 1
      ? ok("and exactly one transcript exists for the call")
      : bad("more than one transcript artifact");
  } finally {
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [derivedTask]).catch(() => undefined);
    await pool.query(`DELETE FROM inbox_events WHERE id = $1`, [inboxEvent]).catch(() => undefined);
    await pool.query(`DELETE FROM calls WHERE call_control_id = ANY($1)`,
      [[CCID, secondCall, derivedCall, inboxCall].filter(Boolean)]);
    for (const a of [artifactId, secondArtifact, derivedArtifact, inboxArtifact].filter(Boolean)) {
      await pool.query(`DELETE FROM artifacts WHERE id = $1`, [a]);
    }
    for (const c of [conversationId, conversationId2].filter(Boolean)) {
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [c]);
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
