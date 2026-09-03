/**
 * Suites must not leave projects behind.
 *
 * Written because litter is not a tidiness problem here - it changes behaviour.
 * A throwaway repro script failed its own cleanup, left one project standing,
 * and Stage B routing then re-homed another suite's inbox event into it:
 *
 *     UPDATE inbox_events
 *        SET conversation_id = COALESCE($3, conversation_id)   -- routeb.ts
 *
 * s37-untrusted-test failed three assertions for two ticks, a bisect indicted
 * six innocent commits, and the notes gained a wrong entry - all from one
 * uncleaned row. The routing behaviour is correct; the litter is what made it
 * bite.
 *
 * So this runs last in the sweep and fails if fixture-shaped projects survived
 * it. Failing loudly here costs a minute; not failing cost most of an evening.
 */
import { createPool } from "../src/db.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/**
 * Slugs that only a test creates.
 *
 * Keyed on the machine-generated shapes suites actually use, never on a bare
 * prefix that a real project might share: `alpha-web` is seeded and permanent,
 * and an earlier cleanup script that matched loosely deleted it and took a
 * suite from 2 failures to 11.
 */
const LITTER = [
  // A machine-generated suffix mixes letters and digits: s37dbg-u6w67,
  // s29-cycle-e7gree. A hand-written fixture slug does not - s10-personal,
  // s16-repo and s18-palette are stable and deliberate, and a pattern that
  // swept them up would fail the sweep for projects that are supposed to exist.
  // The first draft of this matched exactly those, which is the mistake the
  // dev-clean-fixtures script already made once by deleting alpha-web.
  /^[a-z0-9-]+-(?=[a-z0-9]{4,8}$)(?=[a-z0-9]*\d)[a-z0-9]+$/i,
  /^bench-[a-z0-9-]+-(?=[a-z0-9]{6}$)(?=[a-z0-9]*\d)[a-z0-9]+$/i,
];

/** Projects that are meant to exist, whatever they look like. */
const SEEDED = new Set(["alpha-web", "alpha-mobile", "jarvis-improvement", "jarvis"]);

async function main(): Promise<void> {
  const r = await pool.query<{ slug: string }>(`SELECT slug FROM projects ORDER BY slug`);
  const litter = r.rows
    .map((x) => x.slug)
    .filter((s) => !SEEDED.has(s) && LITTER.some((re) => re.test(s)));

  console.log(`${r.rows.length} projects; ${litter.length} look like fixtures left behind`);
  console.log("");

  litter.length === 0
    ? ok("no suite left a fixture project behind")
    : bad(`left behind: ${litter.slice(0, 8).join(", ")}${litter.length > 8 ? ` (+${litter.length - 8})` : ""}`);

  /*
   * The reason this matters, asserted rather than assumed: a leftover project
   * is a routing target. If any survive, say how many conversations they carry,
   * because that is the surface that captures another suite's message.
   */
  if (litter.length) {
    const convs = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversations
        WHERE project_id IN (SELECT id FROM projects WHERE slug = ANY($1))`, [litter]);
    console.log(`  note   - they carry ${convs.rows[0].n} conversation(s), each a routing target`);
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
