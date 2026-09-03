/**
 * S30 N2, end to end: dump a long thread and three PDFs, then ask.
 *
 *   node --import tsx scripts/s30-n2.ts --seed   ingest the scenario
 *   node --import tsx scripts/s30-n2.ts --ask    ask the questions and check
 *
 * The two halves are separate commands on purpose. The Done-when is that N2
 * passes ACROSS A RESTORE FROM BACKUP, so the seeding has to happen, a backup
 * has to run over it, and the asking has to happen against the restored
 * database. A single script that seeds and asks in one process would pass
 * without a backup existing at all, which is the property being tested.
 *
 * "With the clock shifted three weeks forward" is implemented as source dates
 * three weeks in the PAST, which is the same relationship and does not require
 * lying to the system clock. It matters because a retrieval that quietly
 * favours recent material looks perfect on the day you ingest and useless a
 * month later - the failure this part of N2 exists to catch.
 *
 * The second project is not decoration. Cross-project leakage cannot be
 * observed with one project in the database: a query that ignores the project
 * filter entirely returns the right answer when there is only one place for the
 * answer to come from.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../src/db.js";
import { buildPdf } from "./lib/minipdf.js";
import { extractText } from "../src/extract.js";
import { ingestDocument, retrieve, answerFrom, tierOrderFor } from "../src/knowledge.js";

const pool = createPool();
const SEED = process.argv.includes("--seed");
const ASK = process.argv.includes("--ask");

const MINE = "n2-vendor-review";
const OTHER = "n2-northwind";

/** Three weeks back, so asking today is asking three weeks later. */
const WEEKS3 = new Date(Date.now() - 21 * 24 * 3600 * 1000);

/*
 * The fact the whole check turns on. Buried on the last page of one PDF, and
 * nowhere else - not in the thread, not in the other two documents.
 */
const ANSWER = "the 14th";
const BECAUSE = "the 7th is a bank holiday in Ireland";

/*
 * The same shape of fact, in the OTHER project. If project filtering is broken
 * this is what comes back, and it is wrong in a way that reads as right.
 */
const DECOY = "the 21st";

function thread(): string {
  const out: string[] = ["Thread: cutover planning", ""];
  for (let i = 1; i <= 60; i += 1) {
    const who = i % 2 === 0 ? "Enrique" : "Dana";
    out.push(`${who}: message ${i} about staffing, the migration window and who is on call.`);
  }
  out.push("Dana: so are we agreed on a date, or does it wait for the vendor?");
  out.push("Enrique: it waits for nothing, the vendor confirmed weeks ago.");
  return out.join("\n");
}

function pdfLines(title: string, filler: number, tail: string[]): string[] {
  return [
    title, "",
    ...Array.from({ length: filler }, (_, i) => `Paragraph ${i + 1}: scope, staffing, timelines and risk.`),
    ...tail,
  ];
}

async function projectId(slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,'personal','normal','non_production')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`, [slug]);
  return r.rows[0].id;
}

async function seed(): Promise<void> {
  const mine = await projectId(MINE);
  const other = await projectId(OTHER);
  const dir = mkdtempSync(join(tmpdir(), "n2-"));

  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = ANY($1::uuid[])`, [[mine, other]]);

  let chunks = await ingestDocument(pool, {
    projectId: mine, artifactId: null, text: thread(), kind: "chat",
    sourceDate: WEEKS3, locatorPrefix: "thread: cutover planning",
  });
  console.log(`thread: ${chunks} chunks`);

  const docs: [string, string[]][] = [
    ["vendor-review.pdf", pdfLines("Vendor review - meeting notes", 70, [
      `Decision: the cutover moves to ${ANSWER}, because ${BECAUSE}.`,
    ])],
    ["capacity-plan.pdf", pdfLines("Capacity plan", 50, [
      "Headroom is adequate through the end of the quarter.",
    ])],
    ["security-review.pdf", pdfLines("Security review", 40, [
      "No findings above informational. Re-review in six months.",
    ])],
  ];

  for (const [name, lines] of docs) {
    const p = join(dir, name);
    writeFileSync(p, buildPdf(lines));
    const x = await extractText(p, "application/pdf");
    if (!x.ok || !x.text) throw new Error(`extract failed for ${name}: ${x.reason}`);
    chunks = await ingestDocument(pool, {
      projectId: mine, artifactId: null, text: x.text, kind: "prose",
      sourceDate: WEEKS3, locatorPrefix: name,
    });
    console.log(`${name}: ${chunks} chunks`);
  }

  chunks = await ingestDocument(pool, {
    projectId: other, artifactId: null,
    text: pdfLines("Northwind - cutover notes", 8, [
      `Decision: the cutover moves to ${DECOY}, because the venue is unavailable earlier.`,
    ]).join("\n"),
    kind: "prose", sourceDate: WEEKS3, locatorPrefix: "northwind-cutover.pdf",
  });
  console.log(`other project: ${chunks} chunks`);
  console.log("seeded");
}

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); pass += 1; };
const bad = (m: string, extra?: unknown) => {
  console.log(`  FAIL - ${m}${extra === undefined ? "" : `: ${String(extra).slice(0, 200)}`}`);
  fail += 1;
};

async function ask(): Promise<void> {
  const mine = (await pool.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [MINE])).rows[0]?.id;
  const other = (await pool.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [OTHER])).rows[0]?.id;
  if (!mine) { bad(`project ${MINE} is not in this database - was it seeded before the backup?`); return; }

  const total = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM knowledge_chunks WHERE project_id = $1`, [mine]);
  Number(total.rows[0].n) > 20
    ? ok(`the scenario is present: ${total.rows[0].n} chunks in ${MINE}`)
    : bad(`only ${total.rows[0].n} chunks found`);

  const q = "why did the cutover move, and to what date";
  const r = await retrieve(pool, { q, projectId: mine, limit: 8 });
  const a = answerFrom(r, tierOrderFor(q));

  a.known ? ok("the question is answerable") : bad("answered I do not know", a.known === false ? a.reason : "");
  if (a.known) {
    const bodies = a.hits.map((h) => h.body).join(" ");
    bodies.includes(ANSWER)
      ? ok(`the answer is there: ${ANSWER}`)
      : bad("the retrieved text does not contain the date");
    bodies.includes(BECAUSE)
      ? ok("with the reason, which is the part buried on the last page")
      : bad("the reason did not come back");
    a.citations.some((c) => c.includes("vendor-review.pdf"))
      ? ok(`cited correctly: ${a.citations.filter((c) => c.includes("vendor-review")).slice(0, 1)}`)
      : bad("no citation names the document the answer came from", a.citations.slice(0, 4));

    /*
     * The leak check, asserted against the database rather than the text: a
     * chunk from the other project must not appear at all. Checking only that
     * the wrong DATE is absent would pass a retrieval that returned the other
     * chunks and happened to rank them low.
     */
    if (other) {
      const ids = a.hits.map((h) => h.id).filter(Boolean);
      const leaked = ids.length
        ? await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM knowledge_chunks WHERE id = ANY($1::uuid[]) AND project_id = $2`,
          [ids, other])
        : { rows: [{ n: "0" }] };
      leaked.rows[0].n === "0"
        ? ok("and nothing came back from the other project")
        : bad(`${leaked.rows[0].n} chunk(s) leaked from ${OTHER}`);
      bodies.includes(DECOY)
        ? bad(`the date belonging to the other project (${DECOY}) appeared in the answer`)
        : ok("nor its date");
    }

    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    a.hits.every((h) => !h.sourceDate || h.sourceDate < cutoff)
      ? ok("every hit is three weeks old, so age did not hide it")
      : bad("a hit was newer than the scenario");
  }

  /*
   * The honest I-do-not-know. Asked about something plausible for this project
   * and genuinely absent, so a retrieval that returns the least-irrelevant
   * chunks fails here rather than passing everything.
   */
  const q2 = "what did the penetration test say about our payment provider";
  const r2 = await retrieve(pool, { q: q2, projectId: mine, limit: 8 });
  const a2 = answerFrom(r2, tierOrderFor(q2));
  !a2.known
    ? ok("and a question with no answer here gets I do not know")
    : bad("invented an answer for something absent", a2.known && a2.citations.slice(0, 3));

  /*
   * The harder half of the same property, and the one that earns the coverage
   * floor. Every word above is absent from this project, so a retrieval with no
   * floor at all still answers "I do not know" - the assertion passes for a
   * reason that has nothing to do with the rule being tested.
   *
   * This question SHARES a word with the corpus: "staffing" appears in the
   * filler of all three documents. With no floor, that one word is enough to
   * return a page of boilerplate as the answer to a question about approval and
   * budget, which is fluent nonsense with a citation on it.
   */
  const q3 = "who approved the staffing budget";
  const r3 = await retrieve(pool, { q: q3, projectId: mine, limit: 8 });
  const a3 = answerFrom(r3, tierOrderFor(q3));
  !a3.known
    ? ok("and one shared word is not enough to manufacture an answer")
    : bad("answered from a single incidental word", a3.known && a3.hits[0]?.body.slice(0, 90));

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
}

async function main(): Promise<void> {
  if (SEED) await seed();
  if (ASK) await ask();
  if (!SEED && !ASK) console.log("pass --seed or --ask");
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
