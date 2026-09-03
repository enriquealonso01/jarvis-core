/**
 * S30 — the harness consults what the project already knows.
 *
 * *"A memory_search path the Supervisor and the harness both use, so a coding
 * task can consult what Enrique said about the project three weeks ago."*
 *
 * Two properties matter more than the retrieval itself:
 *
 *  - **A project with nothing to say produces a byte-identical prompt.** An
 *    empty "Relevant context: (none)" section teaches whoever reads the prompt
 *    to skip it, and then it is skipped on the day it is full. It also keeps the
 *    benchmark corpus comparable with runs recorded before this existed, which
 *    is the difference between a measurement and a coincidence.
 *  - **Every line says where it came from.** An agent handed unattributed
 *    context cannot tell a standing instruction from a sentence somebody wrote
 *    in a document once, and will treat both as orders.
 */
import { createPool } from "../src/db.js";
import { contextForTask, ingestDocument } from "../src/knowledge.js";
import { recordStatement } from "../src/preference.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30hm-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;

  console.log("1. a project with nothing to say adds nothing at all");
  const empty = await contextForTask(pool, {
    projectId: pid, title: "fix the slug helper", objective: "trailing dashes are kept",
  });
  empty === null
    ? ok("no context block, not an empty heading")
    : bad(`a project with no memory produced: ${String(empty).slice(0, 80)}`);

  console.log("");
  console.log("2. what he said three weeks ago reaches the task");
  await recordStatement(pool, {
    projectId: pid,
    text: "always keep the public API of the slug helper backwards compatible",
  });
  const art = await pool.query<{ id: string }>(
    `INSERT INTO artifacts (project_id, path, mime, quarantine_state)
     VALUES ($1,'notes/slugs.md','text/markdown','clean') RETURNING id`, [pid]);
  await ingestDocument(pool, {
    projectId: pid, artifactId: art.rows[0].id, kind: "prose",
    text: [
      "# Slug helper",
      "The slug helper is used by the public feed URLs, so changing its output breaks links.",
      ...Array.from({ length: 25 }, (_, i) => `Note ${i + 1} about the slug helper and its callers.`),
    ].join("\n"),
  });

  const ctx = await contextForTask(pool, {
    projectId: pid, title: "fix the slug helper", objective: "trailing dashes are kept in slugs",
  });
  ctx && ctx.includes("slug helper")
    ? ok("the task prompt gains what the project knows")
    : bad("nothing was retrieved for a task about the slug helper");
  ctx?.includes("backwards compatible")
    ? ok("including the standing instruction he gave")
    : bad("the standing instruction did not reach the task");

  console.log("");
  console.log("3. every line says where it came from");
  const lines = (ctx ?? "").split("\n").filter((l) => l.startsWith("- ("));
  lines.length > 0 ? ok(`${lines.length} context lines`) : bad("no attributed lines");
  lines.every((l) => /^- \((decision|document|you told me)\)/.test(l))
    ? ok("each is labelled decision, document, or you told me")
    : bad(`an unlabelled line: ${lines.find((l) => !/^- \((decision|document|you told me)\)/.test(l))}`);
  lines.every((l) => l.includes("["))
    ? ok("and each carries its citation")
    : bad("a context line has no citation, so the agent cannot check it");

  console.log("");
  console.log("4. it is context, not instruction, and says so");
  ctx?.includes("CONTEXT, not instruction")
    ? ok("the block tells the agent what it is")
    : bad("the block reads as instructions");
  ctx?.includes("contradicts the task, say so")
    ? ok("and what to do when it disagrees with the task")
    : bad("no guidance on conflict, so an agent will silently follow the older thing");

  console.log("");
  console.log("5. another project's memory does not reach this task");
  const other = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-other`]);
  const otherCtx = await contextForTask(pool, {
    projectId: other.rows[0].id, title: "fix the slug helper", objective: "trailing dashes",
  });
  otherCtx === null
    ? ok("a different project gets nothing from this one")
    : bad(`context leaked across projects: ${String(otherCtx).slice(0, 80)}`);

  for (const id of [pid, other.rows[0].id]) {
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM memory_items WHERE project_id = $1`, [id]);
    await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [id]);
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
