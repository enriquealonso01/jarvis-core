/**
 * Remove leaked fixture projects from a DEV database.
 *
 * Suites create projects and, until now, mostly never removed them. That is not
 * only clutter: it breaks other suites. `s2-task-create-test` asserts that an
 * ambiguous project name is answered by naming the candidates, and it failed
 * because five `alpha-*` projects from previous runs were still there, so the
 * answer listed those instead of the two the test had just created. The suite
 * was correct, the assertion was correct, and the database was full of ghosts.
 *
 * Dry run by default. Deleting rows is not something to do because a script was
 * invoked with no arguments; `--apply` is the deliberate act.
 *
 *   node --import tsx scripts/dev-clean-fixtures.ts            # list
 *   node --import tsx scripts/dev-clean-fixtures.ts --apply    # remove
 */
import { createPool } from "../src/db.js";
import { teardownFixtureProject } from "./lib/fixture.js";

/*
 * Only slugs a SUITE generated, which means only slugs carrying a generated
 * suffix: a unix-millisecond timestamp, or the base-36 stamp the suites use.
 *
 * The first version matched `^(alpha|beta|...)-[a-z0-9]+$`, which also matched
 * `alpha-web` and `alpha-mobile` - the two projects `dev-seed` creates for the
 * ambiguity test. Deleting them took s2 from 2 failures to 11 and s3b from 1 to
 * 9. Re-seeding restored both to green, and the lesson is in the shape of the
 * pattern now: a fixture is identified by the machine-generated suffix it was
 * born with, never by a family name a human might also have chosen.
 */
const FIXTURE_SLUG = "-([0-9]{10,}|[a-z0-9]{6,})$";

/** Never removed, whatever the pattern says: dev-seed creates these and the suites need them. */
const SEEDED = ["alpha-web", "alpha-mobile", "dev-sandbox"];

const apply = process.argv.includes("--apply");

async function main() {
  const pool = createPool();

  /*
   * Opt in explicitly. There is no reliable way to ASK a database whether it is
   * production.
   *
   * The first version of this guard refused when any auth profile had a
   * credential, on the theory that only production has real ones. That is
   * false: the dev database seeds credentials - it is how the engineering
   * ladder picks anthropic_personal in dev - so the guard refused to clean the
   * very database it was written for, while a production database that happened
   * to have none would have sailed through. A heuristic that is both wrong and
   * backwards is worse than an explicit switch.
   *
   * So: the caller says so, in an environment variable, in addition to --apply,
   * and the list is printed either way.
   */
  if (apply && process.env.JARVIS_DEV_CLEAN !== "yes") {
    console.log("");
    console.log("refusing: set JARVIS_DEV_CLEAN=yes to confirm this is a dev database");
    process.exit(2);
  }

  const rows = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM projects
      WHERE slug ~ $1 AND slug <> ALL($2) ORDER BY slug`,
    [FIXTURE_SLUG, SEEDED],
  );
  console.log(`${rows.rowCount} fixture project(s) matched:`);
  for (const r of rows.rows) console.log(`  ${r.slug}`);

  if (!apply) {
    console.log("\ndry run. Pass --apply to remove them.");
    await pool.end();
    return;
  }

  let removed = 0;
  const stuck: string[] = [];
  for (const r of rows.rows) {
    const t = await teardownFixtureProject(pool, r.id).catch((e) => {
      console.log(`  ${r.slug}: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (!t) { stuck.push(r.slug); continue; }
    if (t.leftBehind.length) {
      stuck.push(`${r.slug} (${t.leftBehind.map((l) => l.table).join(",")})`);
      continue;
    }
    removed += 1;
  }
  console.log(`\nremoved ${removed}`);
  if (stuck.length) console.log(`could not remove: ${stuck.join(", ")}`);
  await pool.end();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
