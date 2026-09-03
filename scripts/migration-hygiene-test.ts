/**
 * The two ways a migration file has taken production down, made into rules.
 *
 * Both happened on 2026-09-03, within an hour of each other, and neither was
 * caught by anything that runs before a deploy.
 *
 * FIRST: `056_drop_orphan_schema.sql` deleted from `schema_migrations` using a
 * column called `version`. The column is `filename` — see 001_init.sql, and
 * src/db.ts, which both know this. Postgres raised errorMissingColumn, the
 * migration transaction rolled back, `migrate` threw, and the API crash-looped
 * on startup, because migrations run before it serves. The deploy reported
 * "dist present" and exited 0: it verifies the build, not that anything came
 * back up.
 *
 * SECOND, and still true as this is written: there are two files numbered 056.
 * The ledger keys on filename, so both apply and nothing errors — which is
 * exactly why it went unnoticed. What it costs is ordering: on a fresh database
 * the two run in whatever order the filename sort puts them, and any tool that
 * reasons about "migration 56" now has two answers.
 *
 * The collision cannot be fixed by renaming. `schema_migrations` keys on the
 * filename, so a renamed file is an unapplied migration to the runner: it would
 * re-run on every existing database and leave a ledger row pointing at a name
 * that no longer exists. So the rule below is forward-looking, and the one
 * historical collision is listed explicitly rather than tolerated by a loose
 * check — a list that has to be kept accurate, not a threshold that quietly
 * absorbs the next one.
 */
import fs from "node:fs";
import path from "node:path";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const DIR = path.resolve(process.cwd(), "migrations");

/**
 * Numbers that are already duplicated on production and may not be renamed.
 *
 * One entry, and it is not permission for a second: assertion 3 fails if a
 * number listed here is no longer actually duplicated, so the list cannot
 * quietly outlive the thing it excuses.
 */
const APPLIED_COLLISIONS = new Set(["056"]);

const NAME = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

function main(): void {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

  console.log("1. every migration is named the one way the runner can order");
  const misnamed = files.filter((f) => !NAME.test(f));
  misnamed.length === 0
    ? ok(`all ${files.length} are NNN_lower_snake.sql`)
    : bad(`cannot be ordered by number: ${misnamed.join(", ")}`);

  console.log("");
  console.log("2. no two migrations share a number");
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const n = f.slice(0, 3);
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }
  const dupes = [...byNumber.entries()].filter(([, fs_]) => fs_.length > 1);
  const unexcused = dupes.filter(([n]) => !APPLIED_COLLISIONS.has(n));
  unexcused.length === 0
    ? ok(`${byNumber.size} distinct numbers, no new collisions`)
    : bad(`two migrations claim the same number: ${unexcused.map(([n, f]) => `${n} -> ${f.join(" + ")}`).join("; ")}`);

  console.log("");
  console.log("3. the exception list still describes reality");
  /*
   * Without this, the list is a hole rather than a record. A number listed here
   * that is no longer duplicated means somebody resolved it properly and the
   * entry is now standing permission for the next collision on that number.
   */
  const stale = [...APPLIED_COLLISIONS].filter((n) => (byNumber.get(n)?.length ?? 0) < 2);
  stale.length === 0
    ? ok(`the ${APPLIED_COLLISIONS.size} recorded collision is still real, so the list is a record and not a hole`)
    : bad(`no longer duplicated, so remove from APPLIED_COLLISIONS: ${stale.join(", ")}`);

  console.log("");
  console.log("4. nothing addresses the ledger by a column it does not have");
  /*
   * Checked per STATEMENT rather than per file: 001_init.sql both defines
   * schema_migrations and, elsewhere, has columns of its own called `version`.
   * A file-level check would have to choose between missing the bug and failing
   * on the file that defines the table correctly.
   */
  const offenders: string[] = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DIR, f), "utf8");
    for (const stmt of sql.split(";")) {
      if (!/\bschema_migrations\b/.test(stmt)) continue;
      // The definition itself is where `filename` is introduced; a statement
      // that names another column of the ledger is addressing one that is not
      // there, and Postgres will roll the whole migration back at boot.
      if (/\bversion\b/.test(stmt)) offenders.push(`${f}: ${stmt.trim().split("\n")[0].slice(0, 60)}`);
    }
  }
  offenders.length === 0
    ? ok("every statement touching schema_migrations uses filename")
    : bad(`the ledger has no 'version' column — this rolls back at boot: ${offenders.join(" | ")}`);

  /*
   * And the rule has a source of truth: if 001 ever stops keying the ledger on
   * filename, assertion 4 is checking the wrong column name and would go on
   * passing while being wrong.
   */
  const init = fs.readFileSync(path.join(DIR, "001_init.sql"), "utf8");
  /CREATE TABLE IF NOT EXISTS schema_migrations \(\s*\n\s*filename text PRIMARY KEY/.test(init)
    ? ok("and 001 still says filename is the key, which is what makes rule 4 the right rule")
    : bad("001 no longer keys schema_migrations on filename; rule 4 is now checking the wrong column");

  console.log("");
  console.log("5. no source file contains a control character");
  /*
   * THE TRAP THIS PROJECT HAS NOW PAID FOR THREE TIMES, and DEBUG_NOTES records
   * the first: a regex written as backslash-b reaches the file as a literal
   * 0x08 BACKSPACE, because some layer between the generator and the disk ate
   * the escape. It compiles. It survives grep - the byte is invisible in a
   * terminal, and searching for the text you meant to write finds the line. And
   * it matches nothing, so the assertion built on it passes forever while
   * testing nothing at all.
   *
   * Twice it was found by sabotage, which is luck: sabotage only finds it if the
   * dead assertion happens to be the one under test. This finds it by looking.
   *
   * Tab, newline and carriage return are the only control characters a source
   * file has any business containing.
   */
  const ALLOWED = new Set([9, 10, 13]);
  const NEWLINE = String.fromCharCode(10);
  const roots = ["src", "scripts"];
  const controlOffenders: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    const dir = path.resolve(process.cwd(), root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(ts|mjs|js|sh|sql)$/.test(name)) continue;
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      scanned += 1;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 32 && !ALLOWED.has(code)) {
          const line = text.slice(0, i).split(NEWLINE).length;
          controlOffenders.push(
            `${root}/${name}:${line} contains 0x${code.toString(16).padStart(2, "0")}`);
          break;
        }
      }
    }
  }
  controlOffenders.length === 0
    ? ok(`${scanned} source files, no invisible control characters`)
    : bad(`an escape was eaten before it reached the file: ${controlOffenders.join("; ")}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
