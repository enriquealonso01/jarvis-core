/**
 * S30 scenario N2 — the dump.
 *
 * *"Enrique forwards a 40-message thread and three PDFs. All stored, chunked,
 * indexed. Silence. Three weeks later: what did the client say about the refund
 * window? Answered with a citation."*
 *
 * Two failures are being guarded, and the second is the quieter one:
 *
 *  - a forward that is stored but not indexed has been filed, not kept, and
 *    nobody discovers that until the day they ask;
 *  - a retrieval that finds nothing and answers anyway. That is the natural
 *    shape of this system - three least-irrelevant chunks handed to a model
 *    that writes a confident paragraph - and nothing in that path ever says
 *    "there was nothing here" unless it is built to.
 */
import { createPool } from "../src/db.js";
import { answerFrom, ingestForward, retrieve, type Tier } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30dump-${Math.random().toString(36).slice(2, 7)}`;
const ALL: Tier[] = ["activity", "knowledge", "project_memory", "global_memory"];

/** Forty messages, one of which is the answer three weeks later. */
function thread(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 18; i += 1) lines.push(`client: point ${i} about scheduling and delivery slots`);
  lines.push("client: on refunds, we need the window kept at fourteen days, not thirty");
  lines.push("enrique: understood, fourteen");
  for (let i = 1; i <= 20; i += 1) lines.push(`client: follow-up ${i} about invoicing and contacts`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;
  const inbox = await pool.query<{ id: string }>(
    `INSERT INTO inbox_events (channel, sender, raw_text, checksum, capture_state, processing_state, project_id)
     VALUES ('whatsapp','enrique','(forwarded)','dump-test','persisted','pending',$1) RETURNING id`, [pid]);
  const inboxId = inbox.rows[0].id;

  console.log("1. a forwarded thread is indexed, not merely filed");
  const res = await ingestForward(pool, { inboxEventId: inboxId, projectId: pid, text: thread() });
  res.chunks > 5
    ? ok(`${res.chunks} chunks stored from a 40-message thread`)
    : bad(`only ${res.chunks} chunk(s) - a thread that is stored but not chunked is filed, not kept`);
  !res.error ? ok("and no error was swallowed") : bad(`indexing errored: ${res.error}`);

  console.log("");
  console.log("2. three weeks later, the phrase inside it is answerable with a citation");
  const found = await retrieve(pool, { q: "refund window", projectId: pid });
  const answer = answerFrom(found, ALL);
  answer.known ? ok("an answer is available") : bad(`nothing was found: ${answer.known ? "" : answer.reason}`);
  answer.known && answer.hits.some((h) => h.body.includes("fourteen days"))
    ? ok("and it contains the sentence that answers the question")
    : bad("the retrieved text does not contain the answer");
  answer.known && answer.citations.some((c) => c.includes("forward"))
    ? ok(`cited: ${answer.known ? answer.citations[0] : ""}`)
    : bad(`citations were ${answer.known ? answer.citations.join(" | ") : "none"} - not traceable to the forward`);

  console.log("");
  console.log("3. context survives: the answer carries what it was replying to");
  const hit = answer.known ? answer.hits.find((h) => h.body.includes("fourteen days")) : undefined;
  hit?.body.includes("understood") || hit?.body.includes("point 18")
    ? ok("the answering message is stored with its neighbours")
    : bad("the message was chunked alone, so its context is lost");

  console.log("");
  console.log("4. an honest I do not know when the answer is not there");
  const missing = await retrieve(pool, { q: "penguin husbandry certification", projectId: pid });
  const none = answerFrom(missing, ALL);
  !none.known
    ? ok("nothing found is reported as not known")
    : bad("a question with no answer in the corpus produced an answer anyway");
  !none.known && none.reason.length > 10
    ? ok(`and it says why: ${none.known ? "" : none.reason}`)
    : bad("the refusal carries no reason");
  !none.known && none.searched.length === 4
    ? ok("naming every tier it looked in, so the answer is checkable")
    : bad("the refusal does not say where it looked");

  console.log("");
  console.log("5. no cross-project leakage");
  const other = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-other`]);
  const elsewhere = answerFrom(await retrieve(pool, { q: "refund window", projectId: other.rows[0].id }), ALL);
  !elsewhere.known
    ? ok("another project gets the honest no, not this project's thread")
    : bad("the forwarded thread leaked into another project");

  for (const id of [pid, other.rows[0].id]) {
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM inbox_events WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }

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
