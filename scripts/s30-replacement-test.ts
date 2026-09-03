/**
 * S30 — a replacement that never made it into the index.
 *
 * The plan's line, and it is the failure this suite exists for:
 *
 *   "Superseding an artifact reindexes it. If supersession only touches the
 *    `artifacts` table, the index goes on answering from the old text and
 *    nothing in the console would ever show it."
 *
 * It is reachable, and quarantine is the shortest path to it. Creating v2 with
 * `supersedes_id` set marks every chunk of v1 superseded IMMEDIATELY - the flag
 * is read from the artifacts table at query time, so it does not wait for v2 to
 * be indexed. If v2 then never indexes, the corpus goes from answering
 * correctly to answering from a version labelled out of date, and the only
 * trace of it was a `skipped` string returned to a caller that discards it.
 *
 * The costs are asymmetric, which is what decides the design. Reporting a
 * quarantined file that replaces nothing would train him to ignore the notices
 * that matter - a blocked file being unsearchable is the system working. A
 * quarantined file that replaces something retires the document that was
 * answering, and he finds out on the day he asks a question and gets last
 * month's answer with a "(superseded)" tag on it. So the plain case stays
 * silent and the replacement case always reports, quarantine included.
 *
 * Every assertion here is on the timeline row or on what retrieval returns.
 * "The answer is still right" is not asserted, because it IS still right - it
 * is right and out of date, which is exactly why nobody notices.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { indexArtifact, retrieve } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30repl-${Math.random().toString(36).slice(2, 7)}`;
const QUESTION = "refund window delivered order";

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s30-repl-"));
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  await fs.mkdir(path.join(root, pid), { recursive: true });

  const store = async (
    name: string, body: string, mime: string,
    opts: { quarantine?: string; supersedes?: string } = {},
  ) => {
    const rel = `${pid}/${name}`;
    await fs.writeFile(path.join(root, rel), body);
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, mime, quarantine_state, supersedes_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [pid, rel, mime, opts.quarantine ?? "clean", opts.supersedes ?? null])).rows[0].id;
    return { id, ...(await indexArtifact(pool, id, root)) };
  };

  const notices = async (): Promise<{ title: string; detail: string }[]> =>
    (await pool.query<{ title: string; detail: string }>(
      `SELECT title, detail FROM activity_events
        WHERE project_id = $1 AND kind = 'knowledge' ORDER BY at`, [pid])).rows;

  const answer = async () => {
    const found = await retrieve(pool, { q: QUESTION, projectId: pid, limit: 6 });
    return found.tiers.find((t) => t.tier === "knowledge")?.hits ?? [];
  };

  console.log("1. a document that replaces nothing, and is refused on purpose, stays quiet");
  const unrelated = await store("scan.pdf", "whatever", "application/pdf", { quarantine: "blocked" });
  unrelated.chunks === 0 ? ok("a quarantined artifact is not indexed") : bad("a quarantined artifact was indexed");
  (await notices()).length === 0
    ? ok("and nothing is reported, because a blocked file being unsearchable is the system working")
    : bad(`a quarantined upload raised a notice: ${(await notices())[0]?.title}`);

  console.log("");
  console.log("2. v1 answers");
  const v1 = await store("terms.md", [
    "# Refund window",
    "A delivered order may be refunded within fourteen days.",
  ].join("\n"), "text/markdown");
  v1.chunks > 0 ? ok(`v1 indexed into ${v1.chunks} chunk(s)`) : bad(`v1 did not index: ${v1.skipped}`);
  const before = await answer();
  before.length > 0 && !before[0].superseded
    ? ok("and it is the current answer")
    : bad("v1 does not answer, so there is nothing for a replacement to retire");

  console.log("");
  console.log("3. a replacement arrives and never indexes");
  const v2 = await store("terms-v2.md", "# Refund window\nSeven days.", "text/markdown",
    { quarantine: "pending", supersedes: v1.id });
  v2.chunks === 0
    ? ok(`the replacement was not indexed (${v2.skipped})`)
    : bad("the replacement indexed, so this fixture is not testing anything");

  /*
   * The state the plan warns about, asserted directly. Not "the answer is
   * wrong" - the answer is the same words it always was. What changed is that
   * the corpus now has no current version at all, and says so only in a label
   * on the one hit it can offer.
   */
  const after = await answer();
  after.length > 0
    ? ok("the old text goes on answering")
    : bad("the corpus stopped answering entirely");
  after.every((h) => h.superseded)
    ? ok("and every hit it can offer is marked superseded - there is no current version left")
    : bad("something is still current, so the fixture did not reach the state under test");

  console.log("");
  console.log("4. and THAT is what has to be visible");
  const said = await notices();
  const notice = said.find((n) => n.title.includes("Replacement not searchable"));
  notice
    ? ok(`a notice was raised: "${notice.title}"`)
    : bad(`nothing was reported; the timeline holds: ${said.map((n) => n.title).join(", ") || "(nothing)"}`);
  notice?.title.includes("terms-v2.md")
    ? ok("naming the replacement that did not arrive")
    : bad(`the notice does not name the replacement: ${notice?.title}`);
  notice?.detail.includes("terms.md")
    ? ok("and the document it retired, which is the one still answering")
    : bad(`the notice does not name what is still answering: ${notice?.detail}`);
  notice?.detail.includes("pending")
    ? ok("with the reason it did not index")
    : bad(`the notice does not say why: ${notice?.detail}`);

  console.log("");
  console.log("5. a replacement that DOES index says nothing, or the notice means nothing");
  const v3 = await store("terms-v3.md", "# Refund window\nThree days for a delivered order.",
    "text/markdown", { supersedes: v2.id });
  v3.chunks > 0 ? ok(`v3 indexed into ${v3.chunks} chunk(s)`) : bad(`v3 did not index: ${v3.skipped}`);
  (await notices()).filter((n) => n.title.includes("Replacement not searchable")).length === 1
    ? ok("no second notice: a replacement that arrived is not an event")
    : bad("a successful replacement raised a notice, which makes the notice noise");
  (await answer()).some((h) => !h.superseded)
    ? ok("and the corpus has a current version again")
    : bad("everything is still superseded after a good replacement");

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
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
