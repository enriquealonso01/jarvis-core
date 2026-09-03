/**
 * S30 — a citation names the version, and does not apologise for a name it has.
 *
 * The plan's line: *"A citation names the version. 'Page 4 of the migration
 * report' is not a citation when there are three migration reports."*
 *
 * The version is not invented here. S17 already keeps `artifacts.version` per
 * lineage and increments it as each replacement is recorded, so the citation
 * reads the number the system already maintains rather than deriving a second
 * opinion from a date or a chain walk - two sources for the same fact is how
 * they end up disagreeing. So this suite drives `recordArtifact`, the real
 * writer, rather than inserting artifact rows by hand: a test that sets
 * `version` itself would be asserting against its own fixture.
 *
 * The version is printed only for a document in a lineage - one that replaced
 * something or has been replaced. "terms.md v1" on a document that has no other
 * version is noise, and noise in a citation teaches a reader to skip the part
 * that matters on the day it is not noise.
 *
 * Two smaller things are asserted here because they are the same failure - a
 * citation that does not identify what it points at:
 *
 *  - `citationFor` refuses to print "whole document" as a position, and the
 *    locator prefix used to defeat that check by prepending to it, producing
 *    "forward 0abc1234 — whole document".
 *  - A chunk with no artifact is named by its locator. A forward's locator
 *    already reads "forward 0abc1234"; prefixing it with "a dumped document"
 *    apologises for a name we have.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { recordArtifact } from "../src/artifacts.js";
import { indexArtifact, ingestForward, retrieve, type Hit } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30cite-${Math.random().toString(36).slice(2, 7)}`;
const QUESTION = "database migration rollback window";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s30-cite-"));
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  await fs.mkdir(path.join(root, pid), { recursive: true });

  /** Through the real writer, so `version` is the number the system keeps. */
  const report = async (name: string, body: string, supersedes?: string) => {
    const rel = `${pid}/${name}`;
    await fs.writeFile(path.join(root, rel), body);
    const rec = await recordArtifact(pool, {
      projectId: pid, path: rel, type: "report", mime: "text/markdown",
      quarantineState: "clean", supersedes: supersedes ?? null,
    });
    const indexed = await indexArtifact(pool, rec.id, root);
    return { ...rec, ...indexed };
  };

  const hits = async (): Promise<Hit[]> =>
    (await retrieve(pool, { q: QUESTION, projectId: pid, limit: 10 }))
      .tiers.find((t) => t.tier === "knowledge")?.hits ?? [];

  console.log("1. one report, and its citation says nothing about versions");
  const v1 = await report("migration-report.md", [
    "# Rollback window",
    "The database migration rollback window is four hours after cutover.",
  ].join("\n"));
  v1.version === 1 ? ok("recorded as v1") : bad(`recorded as v${v1.version}`);
  v1.chunks > 0 ? ok(`indexed into ${v1.chunks} chunk(s)`) : bad(`not indexed: ${v1.skipped}`);
  const alone = await hits();
  alone[0]?.citation.includes("migration-report.md")
    ? ok(`cited by name: "${alone[0].citation}"`)
    : bad(`the citation does not name the file: ${alone[0]?.citation}`);
  !/\bv\d/.test(alone[0]?.citation ?? "")
    ? ok("and carries no version, because there is only one of it")
    : bad(`a lone document was cited with a version: ${alone[0]?.citation}`);
  /*
   * uploads.ts stores a clean file at <projectId>/<sha>-<name>, so a citation
   * taken straight from the column opens with a uuid that is the same on every
   * citation in the project. It separates nothing and costs the reader the line.
   */
  !alone[0]?.citation.includes(pid)
    ? ok("and does not open with the project's uuid, which is on every path in the project")
    : bad(`the citation leads with a uuid: ${alone[0]?.citation}`);

  console.log("");
  console.log("2. three migration reports, and each citation says which");
  /*
   * S17 refuses a new version at the same path on purpose - "the previous
   * version's bytes would be overwritten and the two could never be compared" -
   * so the three are three files. That is precisely the plan's complaint: the
   * NAME does not tell a reader which one they are looking at, and three
   * similarly named reports are what the corpus actually contains.
   */
  const v2 = await report("migration-report-sept.md",
    "# Rollback window\nThe database migration rollback window is two hours after cutover.", v1.id);
  const v3 = await report("migration-report-final.md",
    "# Rollback window\nThe database migration rollback window is thirty minutes after cutover.", v2.id);
  v2.version === 2 && v3.version === 3
    ? ok(`the lineage numbered itself v${v2.version} then v${v3.version}`)
    : bad(`the lineage numbered itself v${v2.version} then v${v3.version}`);

  const three = await hits();
  three.length >= 3 ? ok(`all three are retrievable (${three.length} hits)`) : bad(`only ${three.length} hits`);
  const versioned = three.filter((h) => /\bv[123]\b/.test(h.citation));
  versioned.length === three.length
    ? ok("and every citation carries its version")
    : bad(`${three.length - versioned.length} citation(s) do not: ${three.map((h) => h.citation).join(" | ")}`);
  new Set(three.map((h) => h.citation)).size === three.length
    ? ok("so no two hits cite identically - a reader can tell them apart")
    : bad(`two hits cite the same thing: ${three.map((h) => h.citation).join(" | ")}`);
  three.find((h) => h.body.includes("thirty minutes"))?.citation.includes("v3")
    ? ok("the current one is cited as v3")
    : bad(`the current one is cited ${three.find((h) => h.body.includes("thirty minutes"))?.citation}`);
  const old = three.find((h) => h.body.includes("four hours"));
  old?.citation.includes("v1") && old.citation.includes("(superseded)")
    ? ok(`and the oldest reads "${old.citation}" - which version, and that it was replaced`)
    : bad(`the replaced version is cited ${old?.citation}`);

  console.log("");
  console.log("3. a chunk with no artifact is named by its locator");
  const fwd = await ingestForward(pool, {
    inboxEventId: "00000000-0000-4000-8000-00000000abcd",
    projectId: pid,
    text: "Dana: what is the database migration rollback window?\nEli: thirty minutes.",
  });
  fwd.chunks > 0 ? ok(`the forward indexed into ${fwd.chunks} chunk(s)`) : bad(`not indexed: ${fwd.error}`);
  const forwarded = (await hits()).filter((h) => h.citation.includes("forward "));
  forwarded.length > 0
    ? ok(`cited as "${forwarded[0].citation}"`)
    : bad("the forward is not retrievable");
  !forwarded.some((h) => h.citation.includes("whole document"))
    ? ok("without 'whole document', which the prefix used to smuggle past the rule that drops it")
    : bad(`the locator prefix defeated the check: ${forwarded[0]?.citation}`);
  !forwarded.some((h) => h.citation.includes("a dumped document"))
    ? ok("and without apologising for a name it has")
    : bad(`the citation still says 'a dumped document': ${forwarded[0]?.citation}`);
  forwarded.every((h) => h.citation.startsWith("forward "))
    ? ok("the locator IS the citation, and it names the forward it came from")
    : bad(`the citation does not lead with the forward: ${forwarded[0]?.citation}`);

  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM activity_events WHERE project_id = $1`, [pid]);
  await pool.query(`UPDATE artifacts SET supersedes_id = NULL WHERE project_id = $1`, [pid]);
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
