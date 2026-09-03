/**
 * S32 — three weeks later, it still says a stranger wrote it.
 *
 *   "Scraped output is an artifact, so S30 indexes it, so a question three
 *    weeks later can retrieve it — and by then nothing about it says a stranger
 *    wrote it."
 *
 *   "Scraped artifacts carry their origin, and recall surfaces it. 'According
 *    to a page on example.com' and 'according to your notes' must never render
 *    the same way."
 *
 *   "A scrape becomes an artifact with a source, never memory. Memory is what
 *    Enrique told Jarvis; the web is a citation, not a belief."
 *
 * The central assertion is a COMPARISON rather than a pattern match: the same
 * question is asked of a scraped page and of a document he wrote, in one
 * project, and the two citations have to differ. Asserting that a scraped
 * citation contains "example.com" would pass over a system that put the host on
 * everything, and the plan's requirement is about the two rendering
 * differently.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { ingestDocument, retrieve } from "../src/knowledge.js";
import { fileScrapeRun } from "../src/scrapestore.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s32o-${Math.random().toString(36).slice(2, 7)}`;
const QUESTION = "delivery window for a bulk order";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s32-artifacts-"));
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;

  const memoriesBefore = Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items`)).rows[0].n);

  console.log("1. a scrape is filed as an artifact with a source");
  const filed = await fileScrapeRun(pool, {
    projectId: pid,
    originUrl: "https://supplier.example.com/terms?page=1",
    rows: [
      { product: "Widget", note: "The delivery window for a bulk order is six weeks." },
      { product: "Gadget", note: "Stocked items ship next day." },
    ],
    snapshots: [
      { url: "https://supplier.example.com/terms?page=1", html: "<html><body>page one</body></html>" },
      { url: "https://supplier.example.com/terms?page=2", html: "<html><body>page two</body></html>" },
    ],
    root,
  });
  filed.chunks > 0 ? ok(`the rows were indexed into ${filed.chunks} chunk(s)`) : bad("nothing was indexed");
  filed.pageArtifactIds.length === 2
    ? ok("and both raw pages were kept, so a wrong result is diagnosable without re-scraping")
    : bad(`${filed.pageArtifactIds.length} pages kept`);
  /*
   * Each page carries ITS OWN url. An artifact that says it came from the first
   * page of a listing sends whoever is diagnosing page 37 to the wrong document.
   */
  const pageOrigins = (await pool.query<{ origin_url: string }>(
    `SELECT origin_url FROM artifacts WHERE id = ANY($1::uuid[]) ORDER BY path`,
    [filed.pageArtifactIds])).rows.map((r) => r.origin_url);
  pageOrigins[1]?.includes("page=2")
    ? ok(`each page carries the url it came from, not the run's start: ${pageOrigins[1]}`)
    : bad(`page origins are ${JSON.stringify(pageOrigins)}`);

  console.log("");
  console.log("2. and never as memory");
  const memoriesAfter = Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items`)).rows[0].n);
  memoriesAfter === memoriesBefore
    ? ok(`the memory store is untouched (${memoriesBefore} before, ${memoriesAfter} after)`)
    : bad(`a scrape wrote ${memoriesAfter - memoriesBefore} memory item(s) — the web became a belief`);

  console.log("");
  console.log("3. recall says who wrote it");
  // Something he wrote, in the same project, answering the same question.
  const his = (await pool.query<{ id: string }>(
    `INSERT INTO artifacts (project_id, path, mime, quarantine_state)
     VALUES ($1,$2,'text/markdown','clean') RETURNING id`,
    [pid, `${pid}/my-notes.md`])).rows[0].id;
  await ingestDocument(pool, {
    projectId: pid, artifactId: his, kind: "prose",
    text: "# Supplier notes\nI agreed the delivery window for a bulk order verbally at four weeks.",
  });

  const found = await retrieve(pool, { q: QUESTION, projectId: pid, limit: 10 });
  const hits = found.tiers.find((t) => t.tier === "knowledge")?.hits ?? [];
  const scraped = hits.find((h) => h.body.includes("six weeks"));
  const mine = hits.find((h) => h.body.includes("four weeks"));
  scraped && mine
    ? ok("both answers come back for the same question")
    : bad(`only got: ${hits.map((h) => h.citation).join(" | ")}`);
  /*
   * The requirement, asserted as the comparison it is. A pattern match on the
   * host would pass over a system that put the host on everything.
   */
  scraped && mine && scraped.citation !== mine.citation
    ? ok("and they do not render the same way")
    : bad(`the two citations are identical: "${scraped?.citation}"`);
  scraped?.citation.startsWith("a page on supplier.example.com")
    ? ok(`the scraped one leads with the site: "${scraped.citation}"`)
    : bad(`the scraped citation is "${scraped?.citation}"`);
  mine && !mine.citation.includes("a page on")
    ? ok(`while his own document is cited as a document: "${mine.citation}"`)
    : bad(`his own note is cited as a page: "${mine?.citation}"`);

  console.log("");
  console.log("4. an origin is required, not optional");
  /*
   * An optional origin is one a caller forgets on the path that matters, and a
   * scraped artifact without one cites exactly like something he wrote.
   */
  let refused = false;
  try {
    await fileScrapeRun(pool, {
      projectId: pid, originUrl: "", rows: [{ a: "b" }], snapshots: [], root,
    });
  } catch {
    refused = true;
  }
  refused
    ? ok("filing a scrape with no origin is refused rather than defaulted")
    : bad("a scrape was filed with no origin, and will cite like his own notes");

  console.log("");
  console.log("5. the pages are on disk, not just in a row");
  const stored = (await pool.query<{ path: string }>(
    `SELECT path FROM artifacts WHERE id = $1`, [filed.pageArtifactIds[0]])).rows[0];
  const onDisk = await fs.readFile(path.join(root, stored.path), "utf8").catch(() => "");
  onDisk.includes("page one")
    ? ok("the page the site actually served is kept, which stops being knowable the moment it changes")
    : bad("the raw page is not on disk");

  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  await fs.rm(root, { recursive: true, force: true });

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
