/**
 * S30 — retrieval that cites, separates tiers, and refuses to answer from a
 * document that has been replaced.
 *
 * The failure class the plan names is "an answer that looks right": fluent,
 * confident, correctly formatted, and drawn from the wrong place. Every
 * assertion here is one of those, because none of them would be caught by
 * eyeballing output that reads well.
 */
import { createPool } from "../src/db.js";
import { ingestDocument, retrieve } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30-${Math.random().toString(36).slice(2, 8)}`;

async function main(): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;

  const artifact = async (path: string, supersedes?: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, mime, quarantine_state, supersedes_id)
       VALUES ($1,$2,'text/plain','clean',$3) RETURNING id`, [pid, path, supersedes ?? null]);
    return r.rows[0].id;
  };

  console.log("1. a document goes in as chunks that know where they came from");
  const contract = await artifact("contracts/acme-v1.md");
  const n = await ingestDocument(pool, {
    projectId: pid,
    artifactId: contract,
    kind: "prose",
    text: [
      "# Refund window",
      "The client may request a refund within fourteen days of delivery.",
      ...Array.from({ length: 20 }, (_, n) => `Clause R${n + 1} restates the refund terms for completeness.`),
      "",
      "# Late delivery",
      "A delivery more than five days late waives the restocking fee.",
      ...Array.from({ length: 20 }, (_, n) => `Clause L${n + 1} describes carrier delays and remedies.`),
    ].join("\n"),
    sourceDate: new Date("2026-08-01T00:00:00Z"),
  });
  n >= 2 ? ok(`stored ${n} chunks`) : bad(`stored ${n} chunk(s)`);

  const hit = await retrieve(pool, { q: "refund window", projectId: pid });
  const k = hit.tiers.find((t) => t.tier === "knowledge");
  k && k.hits.length > 0
    ? ok("and the phrase inside it is findable")
    : bad("the document was not retrievable by a phrase inside it");
  k?.hits[0].citation.includes("acme-v1.md") && k.hits[0].citation.includes("Refund window")
    ? ok(`cited precisely: ${k?.hits[0].citation}`)
    : bad(`citation was "${k?.hits[0].citation}" - not something a person can check`);

  console.log("");
  console.log("2. ranking finds the passage that discusses it, not merely one that mentions it");
  const relevant = k?.hits[0].body ?? "";
  relevant.includes("fourteen days")
    ? ok("the top hit is the passage that answers the question")
    : bad(`the top hit was: ${relevant.slice(0, 60)}`);

  console.log("");
  console.log("3. re-ingesting replaces, rather than competing with itself");
  await ingestDocument(pool, {
    projectId: pid, artifactId: contract, kind: "prose",
    text: "# Refund window\nThe client may request a refund within thirty days of delivery.",
  });
  const after = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_chunks WHERE source_artifact_id = $1`, [contract]);
  const again = await retrieve(pool, { q: "refund window", projectId: pid });
  const bodies = again.tiers.find((t) => t.tier === "knowledge")?.hits.map((h) => h.body).join(" ") ?? "";
  !bodies.includes("fourteen days") && bodies.includes("thirty days")
    ? ok(`the old generation is gone (${after.rows[0].n} chunks), so the document says one thing`)
    : bad("two generations of chunks are both in the index, so the document says two things");

  console.log("");
  console.log("4. a superseded document does not answer");
  const v2 = await artifact("contracts/acme-v2.md", contract);
  await ingestDocument(pool, {
    projectId: pid, artifactId: v2, kind: "prose",
    text: "# Refund window\nThe client may request a refund within seven days of delivery.",
  });
  const now = await retrieve(pool, { q: "refund window", projectId: pid });
  const live = now.tiers.find((t) => t.tier === "knowledge")?.hits ?? [];
  live.length > 0 ? ok("the current version answers") : bad("nothing answered at all");
  live.every((h) => !h.citation.includes("acme-v1"))
    ? ok("and the replaced version does not, so the answer is not fluently out of date")
    : bad("the superseded version answered - a citation from the document that was replaced");
  const history = await retrieve(pool, { q: "refund window", projectId: pid, includeSuperseded: true });
  (history.tiers.find((t) => t.tier === "knowledge")?.hits ?? []).some((h) => h.citation.includes("acme-v1"))
    ? ok("but it is still reachable when history is asked for deliberately")
    : bad("the old version is unreachable even on request, so nothing can compare versions");

  console.log("");
  console.log("5. tiers are kept apart, and say which is which");
  await pool.query(
    `INSERT INTO memory_items (project_id, kind, body) VALUES ($1,'preference',$2)`,
    [pid, "Enrique prefers the refund window stated in the first paragraph."]);
  await pool.query(
    `INSERT INTO memory_items (project_id, kind, body) VALUES (NULL,'preference',$1)`,
    ["Always state a refund window in plain days, never in weeks."]);
  await pool.query(
    `INSERT INTO activity_events (project_id, kind, title, detail, actor)
     VALUES ($1,'decision','Refund window shortened','Agreed with the client on seven days','enrique')`,
    [pid]);

  const all = await retrieve(pool, { q: "refund window", projectId: pid });
  const names = all.tiers.map((t) => t.tier);
  new Set(names).size === names.length
    ? ok(`each tier appears once: ${names.join(", ")}`)
    : bad(`tiers repeated: ${names.join(", ")}`);
  names.includes("activity") && names.includes("knowledge") && names.includes("global_memory")
    ? ok("a decision, a document and a global preference are all found, and kept apart")
    : bad(`missing tiers: ${names.join(", ")}`);
  all.tiers.every((t) => t.hits.every((h) => h.tier === t.tier))
    ? ok("and every hit is labelled with the tier it came from")
    : bad("a hit is labelled with the wrong tier");
  /*
   * The plan's ordering rule: a decision has a date and a task, so it can be
   * cited most precisely, and it should not be buried under document text.
   */
  names[0] === "activity"
    ? ok("the decision tier comes first, because it can be cited most precisely")
    : bad(`the first tier was ${names[0]}`);

  console.log("");
  console.log("6. project scope holds");
  const other = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-other`]);
  const scoped = await retrieve(pool, { q: "refund window", projectId: other.rows[0].id });
  (scoped.tiers.find((t) => t.tier === "knowledge")?.hits ?? []).length === 0
    ? ok("another project sees none of this project's documents")
    : bad("a document leaked across the project boundary");
  (scoped.tiers.find((t) => t.tier === "global_memory")?.hits ?? []).length > 0
    ? ok("while the global tier is visible from anywhere, which is what makes it global")
    : bad("the global tier vanished when scoped to another project");

  // Clean up
  for (const id of [pid, other.rows[0].id]) {
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM activity_events WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM memory_items WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }
  await pool.query(`DELETE FROM memory_items WHERE body LIKE 'Always state a refund window%'`);

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
