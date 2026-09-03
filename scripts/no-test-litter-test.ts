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
/**
 * A suite fixture: a suite prefix, then a machine-generated tail.
 *
 * Matching on the TAIL alone had a blind spot worth 20 percent of all leaks: a
 * five-character base36 suffix contains no digit one time in five, so
 * `s30tier-kbwqz` slipped past a rule that required one. This matches the shape
 * suites actually generate - a prefix, a hyphen, a short opaque tail - and the
 * protection against over-matching is the explicit KEEP list below rather than
 * a cleverer regex.
 *
 * That trade is deliberate. A false positive here fails a sweep, which is
 * visible and cheap; the same mistake in the REMOVAL script deletes a project,
 * which is how the seeded `alpha-web` was lost once. So this list is broad and
 * `clear-test-litter.ts` stays narrow.
 */
const LITTER = [
  /^s\d+[a-z]*-[a-z0-9]{4,10}$/i,            // s30tier-kbwqz, s28-park-l0096i
  /^s\d+[a-z]*-[a-z0-9-]+-[a-z0-9]{4,12}$/i, // s29-cycle-e7gree, s12-alpha-mtldr1x9
  /^bench-[a-z0-9-]+-[a-z0-9]{5,8}$/i,
  /^selfwatch-[a-z0-9]{4,8}$/i,
];

/**
 * Fixtures that are meant to persist, listed by name because guessing is what
 * deleted alpha-web. Anything added here should be a slug a suite creates
 * deterministically and reuses.
 */
const KEEP = new Set([
  "alpha-web", "alpha-mobile", "jarvis-improvement", "jarvis",
  "s10-personal", "s10-personal-prod", "s10-professional",
  "s16-repo", "s17-console", "s17-outputs", "s18-palette", "s9-review",
  // Kept deliberately by the teardown-cycle suite as its own control.
  "s29-cycle-fvuff0-keep",
]);

const SEEDED = new Set(["alpha-web", "alpha-mobile", "jarvis-improvement", "jarvis"]);

async function main(): Promise<void> {
  const r = await pool.query<{ slug: string }>(`SELECT slug FROM projects ORDER BY slug`);
  const litter = r.rows
    .map((x) => x.slug)
    .filter((s) => !KEEP.has(s) && LITTER.some((re) => re.test(s)));

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
