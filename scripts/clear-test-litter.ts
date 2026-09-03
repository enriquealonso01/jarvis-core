/**
 * Remove fixture projects suites left behind in the DEV database.
 *
 *   node --import tsx scripts/clear-test-litter.ts          list them
 *   node --import tsx scripts/clear-test-litter.ts --write  remove them
 *
 * Litter is not untidiness here. Stage B routing re-homes an inbox event into a
 * matching project, so a leftover fixture is a live routing target: one of them
 * captured another suite's message and cost most of an evening to find.
 *
 * Two safeguards, both learned the hard way:
 *
 *  - it matches only MACHINE-GENERATED slugs, never a hand-written fixture name.
 *    An earlier cleanup script matched loosely, deleted the seeded `alpha-web`,
 *    and took a suite from 2 failures to 11 - a cleanup that breaks tests is
 *    worse than the mess it removes.
 *  - it removes through `teardownFixtureProject`, which is transactional and
 *    walks the foreign keys, so a project either goes completely or not at all.
 *    Hand-rolled DELETEs are what left this litter in the first place.
 *
 * Dev only, by intent: it refuses to run against a database it was not pointed
 * at explicitly.
 */
import { createPool } from "../src/db.js";
import { teardownFixtureProject } from "./lib/fixture.js";

const pool = createPool();
const WRITE = process.argv.includes("--write");

/** Machine-generated: a suffix that mixes letters and digits. */
const LITTER = [
  /^[a-z0-9-]+-(?=[a-z0-9]{4,8}$)(?=[a-z0-9]*\d)[a-z0-9]+$/i,
  /^bench-[a-z0-9-]+-(?=[a-z0-9]{6}$)(?=[a-z0-9]*\d)[a-z0-9]+$/i,
];
const SEEDED = new Set(["alpha-web", "alpha-mobile", "jarvis-improvement", "jarvis"]);

async function main(): Promise<void> {
  const r = await pool.query<{ id: string; slug: string }>(`SELECT id::text, slug FROM projects`);
  const litter = r.rows.filter((x) => !SEEDED.has(x.slug) && LITTER.some((re) => re.test(x.slug)));

  console.log(`${litter.length} fixture project(s) of ${r.rows.length}`);
  for (const p of litter) console.log(`  ${p.slug}`);
  if (!litter.length) return;

  if (!WRITE) {
    console.log("");
    console.log("(dry run - pass --write to remove them)");
    return;
  }

  let removed = 0;
  for (const p of litter) {
    const out = await teardownFixtureProject(pool, p.id).catch((e: unknown) => {
      console.log(`  ${p.slug}: NOT removed - ${e instanceof Error ? e.message.slice(0, 90) : e}`);
      return null;
    });
    if (out && !out.leftBehind.length) removed += 1;
    else if (out) console.log(`  ${p.slug}: left ${JSON.stringify(out.leftBehind)}`);
  }
  console.log(`removed ${removed} of ${litter.length}`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
