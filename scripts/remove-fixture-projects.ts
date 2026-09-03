/**
 * Remove named fixture projects, by slug.
 *
 *   node --import tsx scripts/remove-fixture-projects.ts s12fs-alpha-123 s12fs-beta-123
 *
 * Written for shell suites, which cannot import `removeFixtures` the way the
 * TypeScript ones do. The alternative was a hand-rolled cascade of DELETEs in
 * the shell script itself, and that is precisely the thing that left the litter
 * to begin with: twenty-four tables carry a foreign key to `projects`, a list
 * nobody maintains correctly by hand, and a half-deleted project is worse than
 * an untouched one because it looks fine until something uses it.
 *
 * So this delegates to `teardownFixtureProject`, which is transactional and
 * walks the keys, and it takes explicit slugs rather than a pattern - a cleanup
 * that guesses is how the seeded `alpha-web` was deleted once.
 *
 * Never exits non-zero. It is called from a trap, and a cleanup that fails the
 * run would replace the suite's real result with its own.
 */
import { createPool } from "../src/db.js";
import { teardownFixtureProject } from "./lib/fixture.js";

const pool = createPool();
const slugs = process.argv.slice(2).filter(Boolean);

async function main(): Promise<void> {
  if (!slugs.length) return;
  const r = await pool.query<{ id: string; slug: string }>(
    `SELECT id::text, slug FROM projects WHERE slug = ANY($1)`, [slugs]);
  for (const p of r.rows) {
    const out = await teardownFixtureProject(pool, p.id).catch((e: unknown) => {
      console.log(`  cleanup: ${p.slug} NOT removed - ${e instanceof Error ? e.message.slice(0, 110) : e}`);
      return null;
    });
    if (out && out.leftBehind.length) console.log(`  cleanup: ${p.slug} left ${JSON.stringify(out.leftBehind)}`);
  }
}

main()
  .catch((e) => console.log(`  cleanup: ${e instanceof Error ? e.message.slice(0, 110) : e}`))
  .finally(async () => { await pool.end().catch(() => undefined); });
