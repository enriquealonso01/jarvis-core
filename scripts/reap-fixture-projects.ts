/**
 * Remove fixture projects a suite left behind.
 *
 * Deliberately narrow: it takes slug PATTERNS and refuses to run without one,
 * because the difference between this and a very bad afternoon is the WHERE
 * clause. It prints what it will remove before removing it.
 *
 *   node --import tsx scripts/reap-fixture-projects.ts 's12-alpha-%' 's12-beta-%'
 */
import { createPool } from "../src/db.js";
import { deleteProjects } from "./_teardown.js";

async function main() {
  const patterns = process.argv.slice(2);
  if (!patterns.length) {
    console.error("usage: reap-fixture-projects.ts '<slug-pattern>' [more...]");
    process.exit(2);
  }
  const pool = createPool();
  const r = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM projects WHERE slug LIKE ANY($1) ORDER BY slug`, [patterns]);
  if (!r.rows.length) {
    console.log("nothing matches; nothing to do");
    await pool.end();
    return;
  }
  console.log(`${r.rows.length} project(s) match ${patterns.join(", ")}:`);
  for (const p of r.rows) console.log(`  ${p.slug}`);
  const removed = await deleteProjects(pool, r.rows.map((p) => p.id));
  console.log("\nremoved:");
  for (const [t, n] of Object.entries(removed).sort()) if (n) console.log(`  ${t}: ${n}`);
  await pool.end();
}
main();
