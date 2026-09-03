/**
 * S30 Done-when — N2 still answers after a restore from backup.
 *
 * Every other S30 suite asks the corpus a question while the database that
 * built it is still running. This one asks it of a database that was rebuilt
 * from `pg_dump`, which is the only copy of Jarvis's data that leaves the box
 * (`scripts/jarvis-backup.sh`: the Postgres data directory is a named Docker
 * volume, so the file-level restic snapshot does NOT contain the database).
 *
 * The failure it exists for is the one the plan's Debug section names:
 *
 *   "Poor recall after a restart means the index did not survive — an index
 *    that silently rebuilds empty will answer confidently and wrongly, which is
 *    worse than erroring. Assert on chunk count after boot."
 *
 * That failure has a specific shape here. `knowledge_chunks.search` is a
 * GENERATED column (migration 039), so `pg_dump` does not carry its values at
 * all — it carries the expression, and Postgres recomputes every tsvector on
 * restore. The rows can therefore come back complete while the thing that makes
 * them findable comes back empty, and nothing in the answer path would say so:
 * retrieval would return nothing, `answerFrom` would honestly say it does not
 * know, and an empty corpus and a corpus with no index are indistinguishable
 * from the outside. So the chunk count, the tsvector and the index are asserted
 * directly, on the restored database, before any question is asked of it.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: the restic half. An
 * artifact's BYTES on disk are backed up by restic and restored by
 * `scripts/restore-drill.sh` on the box; what is proved here is that the
 * corpus, its index, its citations and its supersession links survive the
 * database dump the backup actually takes. A chunk answers from its own body,
 * so the answer does not need the file — but the citation points at the
 * artifact row, and that is asserted too.
 *
 * Three phases, because the middle one is a real `pg_dump` and `pg_restore`
 * that only the shell can run:
 *
 *   seed     — build the corpus in the live dev database, record what it
 *              answered BEFORE the dump, and write a manifest.
 *   verify   — run against DATABASE_URL pointed at the RESTORED database and
 *              assert it answers identically.
 *   cleanup  — remove the seeded rows from the live database.
 *
 * Recording the pre-dump answer matters: "some chunk came back" would pass on a
 * corpus that restored into a different order and answers a different question.
 * The assertion is that the same question returns the same passage with the
 * same citation.
 */
import fs from "node:fs/promises";
import { createPool } from "../src/db.js";
import { answerFrom, retrieve, ingestDocument, type Tier } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** On the volume both containers mount, so `seed` and `verify` are separate runs. */
const MANIFEST = "/var/lib/jarvis/s30-restore-seed.json";

/** Answerable only from the middle of the document, and only from project A. */
const N2_QUESTION = "escalation contact production outage";
const NOT_IN_THE_CORPUS = "badger mitigation protocol quarterly";
const SEEDED_AT = "2026-08-13T00:00:00.000Z";

type Manifest = {
  slug: string;
  projectA: string;
  projectB: string;
  chunkCountA: number;
  n2Body: string;
  n2Citation: string;
  n2At: string | null;
};

/** The tiers `answerFrom` is told it looked in, so a refusal is checkable. */
const SEARCHED: Tier[] = ["knowledge", "project_memory", "global_memory", "activity"];

async function seed(): Promise<void> {
  const slug = `s30restore-${Math.random().toString(36).slice(2, 7)}`;
  const mk = async (s: string) => (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [s])).rows[0].id;
  const projectA = await mk(slug);
  const projectB = await mk(`${slug}-other`);

  const artifact = async (pid: string, path: string, supersedes?: string) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, mime, quarantine_state, supersedes_id)
       VALUES ($1,$2,'text/plain','clean',$3) RETURNING id`, [pid, path, supersedes ?? null])).rows[0].id;

  // The answer sits in the middle on purpose. A document whose answer is in the
  // first paragraph is retrievable even from a corpus that restored badly,
  // because the opening of a document survives almost any damage.
  const msaV1 = await artifact(projectA, "contracts/msa-v1.md");
  await ingestDocument(pool, {
    projectId: projectA, artifactId: msaV1, kind: "prose", sourceDate: new Date(SEEDED_AT),
    text: [
      "# Master services agreement",
      ...Array.from({ length: 25 }, (_, i) => `Clause ${i + 1}: general terms and conditions apply to every order.`),
      "",
      "# Escalation",
      "The named escalation contact for a production outage is Priya Raman.",
      ...Array.from({ length: 10 }, (_, i) => `Escalation note ${i + 1}: raise the severity before paging anyone.`),
      "",
      "# Termination",
      ...Array.from({ length: 25 }, (_, i) => `Clause T${i + 1}: notice periods and wind-down obligations.`),
    ].join("\n"),
  });

  // Superseded pair: the link is a self-referencing foreign key on artifacts,
  // and it is what decides which version answers. If the restore loses it, the
  // replaced version answers fluently, with a citation, and is out of date.
  const msaV2 = await artifact(projectA, "contracts/msa-v2.md", msaV1);
  await ingestDocument(pool, {
    projectId: projectA, artifactId: msaV2, kind: "prose", sourceDate: new Date(SEEDED_AT),
    text: "# Escalation\nThe named escalation contact for a production outage is now Tomas Weiss.",
  });

  // The same fact, in another project. Asking as A must not reach it — and the
  // assertion is on the RETRIEVAL, not on whether the name appears in prose.
  const other = await artifact(projectB, "contracts/other-msa.md");
  await ingestDocument(pool, {
    projectId: projectB, artifactId: other, kind: "prose", sourceDate: new Date(SEEDED_AT),
    text: "# Escalation\nThe named escalation contact for a production outage is Dmitri Volkov.",
  });

  await pool.query(
    `INSERT INTO memory_items (project_id, kind, body) VALUES ($1,'preference',$2)`,
    [projectA, "Always page the escalation contact before opening a production outage ticket."]);
  // Withdrawn, kept for the audit. It must survive the restore as a record and
  // still not answer: a rule he retracted answering after a restore is worse
  // than losing it, because nobody would think to look.
  await pool.query(
    `INSERT INTO memory_items (project_id, kind, body, superseded_at, superseded_reason)
     VALUES ($1,'preference',$2, now(), 'replaced')`,
    [projectA, "Never page the escalation contact about a production outage out of hours."]);
  await pool.query(
    `INSERT INTO activity_events (project_id, kind, title, detail, actor)
     VALUES ($1,'decision','Escalation contact changed','Agreed with the client to name a production outage contact','enrique')`,
    [projectA]);

  const before = await retrieve(pool, { q: N2_QUESTION, projectId: projectA });
  const top = before.tiers.find((t) => t.tier === "knowledge")?.hits[0];
  if (!top) throw new Error("the seed does not answer its own question before the dump — nothing to compare a restore against");
  const count = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_chunks WHERE project_id = $1`, [projectA]);

  const manifest: Manifest = {
    slug, projectA, projectB,
    chunkCountA: Number(count.rows[0].n),
    n2Body: top.body, n2Citation: top.citation, n2At: top.at,
  };
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`  seeded ${manifest.chunkCountA} chunks in ${slug}`);
  console.log(`  before the dump it answered: ${top.citation}`);
}

async function verify(): Promise<void> {
  const m: Manifest = JSON.parse(await fs.readFile(MANIFEST, "utf8"));

  console.log("1. the corpus came back whole, and findable");
  const count = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_chunks WHERE project_id = $1`, [m.projectA]);
  Number(count.rows[0].n) === m.chunkCountA
    ? ok(`${count.rows[0].n} chunks restored, the same number that went in`)
    : bad(`${count.rows[0].n} chunks restored, ${m.chunkCountA} went in`);

  /*
   * The generated tsvector, checked directly rather than through an answer.
   * `pg_dump` carries the expression and not the values, so this column is
   * recomputed by the restore. If it came back empty every row would still be
   * present and every question would return nothing - which reads exactly like
   * a corpus that has nothing to say.
   */
  const empty = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_chunks
      WHERE project_id = $1 AND (search IS NULL OR search = ''::tsvector)`, [m.projectA]);
  Number(empty.rows[0].n) === 0
    ? ok("every restored chunk has a tsvector, so the index was recomputed rather than left empty")
    : bad(`${empty.rows[0].n} restored chunks have an empty tsvector and can never be retrieved`);

  /*
   * Index PRESENCE, not index usage. On a table this small the planner will
   * choose a sequential scan whatever exists, so asserting on a plan would be
   * asserting on the row count. What is checkable is that the restore rebuilt
   * the index at all: without it the same query is a sequential scan over every
   * chunk ever stored, which on a real corpus is slow enough to time out, and a
   * timed-out question is answered "I don't know".
   */
  const idx = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'knowledge_chunks' AND indexname = 'knowledge_chunks_search_idx'`);
  idx.rowCount === 1
    ? ok("the GIN index on the tsvector was rebuilt by the restore")
    : bad("the GIN index is missing from the restored database");

  console.log("");
  console.log("2. N2 — the same question, the same passage, the same citation");
  const after = await retrieve(pool, { q: N2_QUESTION, projectId: m.projectA });
  const k = after.tiers.find((t) => t.tier === "knowledge")?.hits ?? [];
  const top = k[0];
  top ? ok("the restored corpus answers the question") : bad("the restored corpus answers nothing at all");
  top?.body === m.n2Body
    ? ok("with the same passage it answered with before the dump, not merely one that mentions the words")
    : bad(`a different passage answered: ${top?.body.slice(0, 70)}`);
  top?.citation === m.n2Citation
    ? ok(`cited identically: ${top?.citation}`)
    : bad(`the citation changed: "${m.n2Citation}" became "${top?.citation}"`);
  /*
   * The middle of the long document, which is the property N2 is actually
   * about. The top hit is the one-line current version, so asserting on it
   * alone would pass on a corpus where the 60-clause agreement restored as
   * nothing: the opening and the closing of a document survive damage that
   * loses its middle, and a heading twenty-five clauses in does not.
   */
  const middle = k.find((h) => h.body.includes("Priya Raman"));
  middle?.citation.includes("Escalation")
    ? ok(`the middle of the long agreement is still retrievable, and still located: ${middle.citation}`)
    : bad("the passage from the middle of the long document did not come back with its locator");
  // S41 will search on this date, and the plan is explicit that backfilling a
  // date nobody recorded is guesswork. A restore that drops it is that loss.
  top?.at?.startsWith("2026-08-13")
    ? ok("and it still carries the date the source is from, which S41 searches on")
    : bad(`source_date did not survive the restore: ${top?.at}`);

  console.log("");
  console.log("3. the replaced version is still replaced");
  top && !top.superseded && top.citation.includes("msa-v2")
    ? ok("the current version answers first")
    : bad(`the first hit after the restore was ${top?.citation}`);
  k.some((h) => h.superseded && h.citation.includes("msa-v1") && h.citation.includes("(superseded)"))
    ? ok("and the replaced one is offered, labelled, so a reader can see what changed")
    : bad("the supersession link did not survive the restore, so nothing is marked replaced");

  console.log("");
  console.log("4. the project boundary survived the restore");
  const ids = k.map((h) => h.id);
  const leaked = ids.length
    ? await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM knowledge_chunks WHERE id = ANY($1::uuid[]) AND project_id <> $2`,
        [ids, m.projectA])
    : { rows: [{ n: "0" }] };
  Number(leaked.rows[0].n) === 0
    ? ok("nothing retrieved for this project belongs to another one")
    : bad(`${leaked.rows[0].n} retrieved chunks belong to another project`);
  const asB = await retrieve(pool, { q: N2_QUESTION, projectId: m.projectB });
  const bodiesB = (asB.tiers.find((t) => t.tier === "knowledge")?.hits ?? []).map((h) => h.body).join(" ");
  bodiesB.includes("Dmitri") && !bodiesB.includes("Priya") && !bodiesB.includes("Tomas")
    ? ok("and the other project still answers from its own document and only its own")
    : bad("the other project's answer is wrong after the restore");

  console.log("");
  console.log("5. an honest no is still honest");
  const nothing = await retrieve(pool, { q: NOT_IN_THE_CORPUS, projectId: m.projectA });
  const answer = answerFrom(nothing, SEARCHED);
  answer.known === false
    ? ok(`a question the corpus cannot answer is refused: "${answer.reason}"`)
    : bad("a restored corpus answered a question that is not in it");
  answer.known === false && answer.searched.length === SEARCHED.length
    ? ok("naming every tier it looked in, so the no is checkable")
    : bad("the refusal does not say where it looked");

  console.log("");
  console.log("6. memory and activity came back with the corpus");
  const mem = await retrieve(pool, { q: "page the escalation contact", projectId: m.projectA });
  const memHits = (mem.tiers.find((t) => t.tier === "project_memory")?.hits ?? []).map((h) => h.body).join(" ");
  memHits.includes("Always page")
    ? ok("the live preference answers")
    : bad("the preference did not survive the restore");
  !memHits.includes("Never page")
    ? ok("and the withdrawn one does not")
    : bad("a preference he withdrew answers again after the restore");
  const audit = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items
      WHERE project_id = $1 AND superseded_at IS NOT NULL AND superseded_reason = 'replaced'`,
    [m.projectA]);
  Number(audit.rows[0].n) === 1
    ? ok("while staying in the audit, which is the half a delete would have destroyed")
    : bad("the withdrawn preference is not in the restored audit");
  const why = await retrieve(pool, { q: "why did we agree the escalation contact", projectId: m.projectA });
  (why.tiers.find((t) => t.tier === "activity")?.hits ?? []).length > 0
    ? ok("and the decision behind it is still answerable from activity")
    : bad("the activity tier lost its decision in the restore");

  console.log("");
  console.log("7. the citation points at a row that is actually there");
  const art = await pool.query<{ path: string }>(
    `SELECT path FROM artifacts WHERE project_id = $1 ORDER BY path`, [m.projectA]);
  art.rows.length === 2 && art.rows[0].path === "contracts/msa-v1.md"
    ? ok("both artifact rows restored with their paths, so a citation resolves to something")
    : bad(`artifact rows did not restore: ${art.rows.map((r) => r.path).join(", ")}`);
}

async function cleanup(): Promise<void> {
  let m: Manifest;
  try {
    m = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
  } catch {
    console.log("  nothing to clean up");
    return;
  }
  for (const pid of [m.projectA, m.projectB]) {
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM memory_items WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM activity_events WHERE project_id = $1`, [pid]);
    // The superseding artifact points at the one it replaced, so the pointer
    // goes before the row it points at or the delete fails on its own link.
    await pool.query(`UPDATE artifacts SET supersedes_id = NULL WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }
  await fs.rm(MANIFEST, { force: true });
  console.log(`  removed ${m.slug} and its pair`);
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  if (phase === "seed") await seed();
  else if (phase === "verify") await verify();
  else if (phase === "cleanup") await cleanup();
  else throw new Error(`unknown phase "${phase}" - expected seed, verify or cleanup`);

  if (phase === "verify") {
    console.log("");
    console.log(`==== ${passes} passed, ${fails} failed ====`);
  }
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
