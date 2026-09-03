/**
 * S18b — every table in the database is documented, and stays documented.
 *
 * The schema grew from 37 tables to 57 while DATA_MODEL.md described 37. The
 * same-commit rule is supposed to keep it current, and a rule with nothing
 * checking it is how the gap opened in the first place - so this reads the live
 * schema and the document and compares them.
 *
 * It fails in both directions. An undocumented table is the drift everyone
 * expects; a documented table that no longer exists is the one that quietly
 * turns the file into fiction, and reading a confident paragraph about a table
 * that was dropped is worse than finding nothing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const DOCS = process.env.JARVIS_DOCS_DIR ?? "docs";

/**
 * Headings, one table each.
 *
 * Deliberately strict about one-table-per-heading: the first draft of this
 * documentation put three tables under a single heading, which reads fine and
 * is invisible to any per-table check - so two of them stayed "undocumented"
 * while looking documented. A heading that names one table is what makes this
 * verifiable at all.
 */
async function documentedTables(): Promise<Set<string>> {
  const text = await fs.readFile(path.join(DOCS, "DATA_MODEL.md"), "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^##\s+`?([a-z_][a-z0-9_]*)`?\s*$/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

async function main(): Promise<void> {
  const documented = await documentedTables();
  const r = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const live = r.rows.map((x) => x.table_name);

  console.log(`the database has ${live.length} tables; the document names ${documented.size}`);
  console.log("");

  const undocumented = live.filter((t) => !documented.has(t));
  undocumented.length === 0
    ? ok("every table in the database has a section")
    : bad(`undocumented: ${undocumented.join(", ")}`);

  const ghosts = [...documented].filter((t) => !live.includes(t));
  ghosts.length === 0
    ? ok("and every documented table still exists")
    : bad(`documented but gone, so the file is fiction here: ${ghosts.join(", ")}`);

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
