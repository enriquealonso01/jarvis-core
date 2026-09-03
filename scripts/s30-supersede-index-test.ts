/**
 * S30 — supersede a document and assert what RETRIEVAL sees, not what it says.
 *
 * The plan's line is precise about this and it is the only S30 test line no
 * suite had taken literally:
 *
 *   "Supersede an artifact and assert the index changed. Do not assert on the
 *    answer alone — an answer can be right for the wrong reason."
 *
 * s30-retrieval-test already asserts the answer: v2 comes first, v1 is offered
 * labelled. That passes for a reason it cannot see. If the ordering rule were
 * removed and v2 merely happened to rank higher - because it is shorter, or
 * newer, or repeats the query terms more densely - the assertion stays green
 * and the system has no supersession at all. The fixture there is built to make
 * that hard, and "hard" is not "impossible".
 *
 * So this suite asserts on structure, by IDENTITY. The same chunk ids, fetched
 * before and after v2 exists, must come back with a different `superseded`
 * flag and in a different order. A chunk id cannot rank higher by accident.
 *
 * A NOTE ON "THE INDEX CHANGED", because this design does not literally change
 * one and pretending otherwise would be the failure this suite exists to catch.
 * `superseded` is computed at query time from an EXISTS join on
 * `artifacts.supersedes_id` - nothing is rewritten when v2 arrives, and the GIN
 * index is untouched. That is deliberate: a stored flag has to be maintained by
 * whoever writes the supersession, and a flag that can drift from the link it
 * mirrors is how a replaced document quietly starts answering again. What the
 * plan's line is protecting is that the answer changed for a checkable
 * structural reason rather than by luck of the ranker, and that is exactly what
 * is asserted here - on the flag and the order, per chunk id, not on the prose.
 */
import { createPool } from "../src/db.js";
import { ingestDocument, ingestForward, retrieve, type Hit } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30sup-${Math.random().toString(36).slice(2, 7)}`;
const QUESTION = "refund window for a delivered order";

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;

  const artifact = async (path: string, supersedes?: string) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, mime, quarantine_state, supersedes_id)
       VALUES ($1,$2,'text/plain','clean',$3) RETURNING id`, [pid, path, supersedes ?? null])).rows[0].id;

  const hits = async (): Promise<Hit[]> =>
    (await retrieve(pool, { q: QUESTION, projectId: pid, limit: 10 }))
      .tiers.find((t) => t.tier === "knowledge")?.hits ?? [];

  const chunkIds = async (artifactId: string): Promise<string[]> =>
    (await pool.query<{ id: string }>(
      `SELECT id::text FROM knowledge_chunks WHERE source_artifact_id = $1 ORDER BY chunk_index`,
      [artifactId])).rows.map((r) => r.id);

  console.log("1. before anything replaces it, v1 is current");
  const v1 = await artifact("contracts/terms-v1.md");
  await ingestDocument(pool, {
    projectId: pid, artifactId: v1, kind: "prose",
    text: [
      "# Refund window",
      "A delivered order may be refunded within fourteen days.",
      ...Array.from({ length: 12 }, (_, i) => `Refund clause ${i + 1}: the refund window covers every delivered order.`),
    ].join("\n"),
  });
  const v1Ids = await chunkIds(v1);
  v1Ids.length > 0 ? ok(`v1 stored ${v1Ids.length} chunk(s)`) : bad("v1 stored nothing");

  const before = await hits();
  const beforeById = new Map(before.map((h) => [h.id, h]));
  v1Ids.every((id) => beforeById.get(id)?.superseded === false)
    ? ok("and every one of them is returned as current")
    : bad("a chunk is already marked superseded before anything replaced it");
  v1Ids.some((id) => beforeById.has(id))
    ? ok("with v1 answering the question")
    : bad("v1 does not answer its own question, so there is nothing to supersede");

  console.log("");
  console.log("2. v2 arrives, and the SAME chunk ids come back different");
  const v2 = await artifact("contracts/terms-v2.md", v1);
  await ingestDocument(pool, {
    projectId: pid, artifactId: v2, kind: "prose",
    text: "# Refund window\nA delivered order may be refunded within seven days.",
  });
  const v2Ids = await chunkIds(v2);

  /*
   * The whole point of the suite. Nothing about these rows was rewritten - the
   * ids, the bodies and the tsvectors are byte-for-byte what they were - so a
   * changed flag can only come from the supersession link being read at query
   * time. This is the assertion an answer-only test cannot make: it survives a
   * ranker that would have put v2 first anyway.
   */
  const after = await hits();
  const afterById = new Map(after.map((h) => [h.id, h]));
  const flipped = v1Ids.filter((id) => beforeById.get(id)?.superseded === false
    && afterById.get(id)?.superseded === true);
  flipped.length === v1Ids.filter((id) => beforeById.has(id)).length && flipped.length > 0
    ? ok(`${flipped.length} chunk id(s) that were current are now returned as superseded, unchanged in every other respect`)
    : bad(`the flag did not flip on the same ids: ${flipped.length} of ${v1Ids.length}`);

  // Offered, not dropped. The rows are still there, and still retrieved.
  const stillStored = await chunkIds(v1);
  stillStored.length === v1Ids.length && stillStored.every((id, i) => id === v1Ids[i])
    ? ok("the replaced version's chunks were not deleted, so what changed is still visible")
    : bad("superseding v1 destroyed its chunks, so nobody can see what changed");
  v1Ids.some((id) => afterById.has(id))
    ? ok("and they are still retrieved rather than filtered out of the result")
    : bad("the replaced version was silently dropped from retrieval");

  console.log("");
  console.log("3. the ORDER changed, not just the label");
  const rank = (id: string) => after.findIndex((h) => h.id === id);
  const lastCurrent = Math.max(...v2Ids.filter((id) => afterById.has(id)).map(rank));
  const firstOld = Math.min(...v1Ids.filter((id) => afterById.has(id)).map(rank));
  Number.isFinite(lastCurrent) && lastCurrent >= 0 && firstOld > lastCurrent
    ? ok(`every current chunk outranks every replaced one (positions ${lastCurrent} then ${firstOld})`)
    : bad(`a replaced chunk ranks above a current one (current ends at ${lastCurrent}, replaced starts at ${firstOld})`);
  /*
   * "every superseded hit is labelled" is vacuously true when NOTHING is
   * superseded, so it passed while the flag was sabotaged dead - the assertion
   * agreed with a system that had no supersession at all. It has to require the
   * hit to exist before it can require the label.
   */
  const labelled = after.filter((h) => h.superseded);
  labelled.length > 0 && labelled.every((h) => h.citation.includes("(superseded)"))
    ? ok(`${labelled.length} replaced hit(s), each saying so in its citation where a reader will see it`)
    : bad(`${labelled.length} replaced hits came back labelled`);

  console.log("");
  console.log("4. a chain, because v2 is not the last word either");
  const v3 = await artifact("contracts/terms-v3.md", v2);
  await ingestDocument(pool, {
    projectId: pid, artifactId: v3, kind: "prose",
    text: "# Refund window\nA delivered order may be refunded within three days.",
  });
  const chained = new Map((await hits()).map((h) => [h.id, h]));
  v2Ids.every((id) => !chained.has(id) || chained.get(id)?.superseded === true)
    ? ok("v2 is superseded in its turn without anything touching its rows")
    : bad("v2 still reads as current after v3 replaced it");
  v1Ids.every((id) => !chained.has(id) || chained.get(id)?.superseded === true)
    ? ok("and v1 stays superseded rather than being revived by the next replacement")
    : bad("v1 came back as current when v3 arrived");
  const v3Ids = await chunkIds(v3);
  v3Ids.every((id) => !chained.has(id) || chained.get(id)?.superseded === false)
    ? ok("while v3, which nothing replaces, is the current one")
    : bad("v3 is marked superseded and nothing supersedes it");

  console.log("");
  console.log("5. what has no artifact is unaffected by a supersession beside it");
  /*
   * A forward has no artifact to point at, so `source_artifact_id` is NULL, and
   * the flag is decided by a correlated EXISTS against exactly that column. A
   * comparison to NULL is never true, so the present expression CANNOT mark one
   * superseded - which makes this a regression guard on a future rewrite rather
   * than something today's code can fail, and saying otherwise would overstate
   * it. The half that has genuinely failed before is the other one: a forward
   * was stored and not indexed, and a thread nobody can retrieve has been filed
   * rather than kept. Both are asserted, in one project where a supersession is
   * going on beside it.
   */
  const fwd = await ingestForward(pool, {
    inboxEventId: "00000000-0000-4000-8000-0000000000ff",
    projectId: pid,
    text: "Ana: what is the refund window for a delivered order?\nBen: fourteen days, per the terms.\nAna: noted.",
  });
  fwd.chunks > 0 ? ok(`a forward indexed into ${fwd.chunks} chunk(s)`) : bad(`the forward did not index: ${fwd.error}`);
  const withForward = await hits();
  const forwardHits = withForward.filter((h) => h.citation.includes("forward "));
  forwardHits.length > 0
    ? ok(`and it is retrievable alongside the contract versions, cited as "${forwardHits[0].citation}"`)
    : bad("the forward is not retrievable at all");
  forwardHits.every((h) => h.superseded === false)
    ? ok("and none of it is marked superseded, because nothing replaced it")
    : bad("a forwarded message was marked superseded by a contract it has nothing to do with");

  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM activity_events WHERE project_id = $1`, [pid]);
  await pool.query(`UPDATE artifacts SET supersedes_id = NULL WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
