/**
 * Seed a document on the live box, ask about it, ask about something that is
 * not there, and clean up.
 *
 * Used by tests/s30-ask-live.sh. It exists as a file rather than an inline
 * heredoc because the Bash tool mangles quoting, and a probe that fails for
 * quoting reasons looks exactly like a probe that found a bug.
 */
import { createPool } from "../src/db.js";
import { answerFrom, ingestDocument, retrieve, type Tier } from "../src/knowledge.js";

const pool = createPool();
const ALL: Tier[] = ["activity", "knowledge", "project_memory", "global_memory"];
const SLUG = `s30-live-${Math.random().toString(36).slice(2, 7)}`;

const p = await pool.query<{ id: string }>(
  `INSERT INTO projects (slug,name,project_type,confidentiality)
   VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
const pid = p.rows[0].id;
const a = await pool.query<{ id: string }>(
  `INSERT INTO artifacts (project_id, path, mime, quarantine_state)
   VALUES ($1,$2,'text/markdown','clean') RETURNING id`, [pid, `${SLUG}/terms.md`]);

try {
  const n = await ingestDocument(pool, {
    projectId: pid,
    artifactId: a.rows[0].id,
    kind: "prose",
    text: [
      "# Refund window",
      "The client may request a refund within fourteen days of delivery.",
      ...Array.from({ length: 25 }, (_, i) => `Clause ${i + 1} restates the refund terms.`),
    ].join("\n"),
    sourceDate: new Date(),
  });
  console.log(`ingested chunks=${n}`);

  const answer = answerFrom(await retrieve(pool, { q: "refund window", projectId: pid }), ALL);
  console.log(`known=${answer.known}`);
  if (answer.known) {
    console.log(`citation=${answer.citations[0]}`);
    console.log(`text=${answer.hits[0].body.slice(0, 60).replace(/\n/g, " ")}`);
  }

  const none = answerFrom(await retrieve(pool, { q: "penguin husbandry", projectId: pid }), ALL);
  console.log(`unanswerable known=${none.known}`);
} finally {
  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  await pool.end();
}
