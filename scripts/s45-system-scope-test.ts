/**
 * S45 — system work is not a project.
 *
 *   "Maintenance, health, security sweeps, self-improvement and internal repair
 *    are **the system operating itself**... putting them there means his Projects
 *    view and his project counts are permanently contaminated by Jarvis's
 *    housekeeping."
 *
 * Two assertions carry this suite, and the Debug note supplies the first:
 *
 *   "If system work reappears in project views, something is filtering by name
 *    rather than by scope. **Name-based filters break the first time something is
 *    renamed.**"
 *
 * So a system project is RENAMED mid-suite — slug and name — and has to stay out
 * of the portfolio view. A filter matching `jarvis-` passes every other assertion
 * here and fails that one.
 *
 * And the second, which is what a taxonomy change is most likely to break while
 * nobody is looking:
 *
 *   "A system-scoped task still cannot read a project's secrets — **the boundary
 *    survives the re-labelling.**"
 *
 * "This is a taxonomy change, not a permissions change" is easy to write and easy
 * to violate by tidying the boundary at the same time, so the isolation check is
 * run against the real `checkConnectionAccess` rather than restated here.
 */
import { createPool } from "../src/db.js";
import { checkConnectionAccess } from "../src/isolation.js";
import {
  describeSystemActivity, markersDisagree, portfolioCount, PORTFOLIO_ONLY,
  scopeFrom, SYSTEM_ONLY, systemActivity, whereForScope,
} from "../src/systemscope.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s45-${Math.random().toString(36).slice(2, 7)}`;
const SINCE = new Date("2026-09-01T00:00:00Z");

const listed = async (scope: string) => {
  const r = await pool.query<{ slug: string }>(
    `SELECT p.slug FROM projects p
      WHERE p.archived_at IS NULL AND ${whereForScope(scopeFrom(scope))}`,
  );
  return r.rows.map((x) => x.slug);
};

async function main(): Promise<void> {
  let mine = "";
  let housekeeping = "";
  try {
    mine = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-real`])).rows[0].id;
    housekeeping = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality,is_system)
       VALUES ($1,$1,'system','normal',true) RETURNING id`, [`${SLUG}-sweep`])).rows[0].id;

    console.log("1. the Projects view is his projects");
    const portfolio = await listed("portfolio");
    portfolio.includes(`${SLUG}-real`) && !portfolio.includes(`${SLUG}-sweep`)
      ? ok("his project is listed and the system one is not")
      : bad(`portfolio: ${portfolio.join(", ")}`);
    /*
     * The two seeded by ADR 012 are the whole reason this step exists, so they
     * are named rather than left to a generic count.
     */
    !portfolio.includes("jarvis-maintenance") && !portfolio.includes("jarvis-improvement")
      ? ok("and neither jarvis-maintenance nor jarvis-improvement is in it")
      : bad(`ADR 012's seeds are still in the Projects view: ${portfolio.join(", ")}`);
    const count = await portfolioCount(pool);
    count === portfolio.length
      ? ok(`the count matches what he would count: ${count}`)
      : bad(`count ${count} but ${portfolio.length} listed`);

    console.log("");
    console.log("2. he can still see the system area");
    const system = await listed("system");
    system.includes(`${SLUG}-sweep`) && !system.includes(`${SLUG}-real`)
      ? ok("asking for system scope gives system work and only that")
      : bad(`system: ${system.join(", ")}`);
    (await listed("all")).length === portfolio.length + system.length
      ? ok("and 'all' is exactly the two together, with nothing falling between them")
      : bad("the scopes do not partition the projects");
    scopeFrom(undefined) === "portfolio" && scopeFrom("nonsense") === "portfolio"
      ? ok("an absent or unrecognised scope is his portfolio, not everything")
      : bad("a typo repopulated the view with housekeeping");

    console.log("");
    console.log("3. filtered by scope, not by name");
    /*
     * THE ASSERTION THE DEBUG NOTE ASKS FOR. A filter matching "jarvis-" passes
     * every assertion above and fails this one.
     */
    await pool.query(
      `UPDATE projects SET slug = $2, name = 'Nightly housekeeping' WHERE id = $1`,
      [housekeeping, `${SLUG}-renamed-away-from-jarvis`]);
    const afterRename = await listed("portfolio");
    !afterRename.includes(`${SLUG}-renamed-away-from-jarvis`)
      ? ok("renaming a system project does not smuggle it into the Projects view")
      : bad("A NAME-BASED FILTER: the renamed system project reappeared");
    (await listed("system")).includes(`${SLUG}-renamed-away-from-jarvis`)
      ? ok("and it is still in the system area under its new name")
      : bad("the renamed project fell out of both scopes");
    !PORTFOLIO_ONLY.includes("jarvis") && !SYSTEM_ONLY.includes("slug")
      ? ok("the fragments themselves mention no slug and no name")
      : bad(`a scope fragment matches on a name: ${PORTFOLIO_ONLY} / ${SYSTEM_ONLY}`);

    console.log("");
    console.log("4. one fact, two columns, and they agree");
    /*
     * is_system and project_type='system' both record the same thing. Not a rule
     * this step invents - but two records of one fact drift silently, and the
     * failure is that one query filters on the type and another on the boolean,
     * so system work reappears in exactly half the places.
     */
    const drift = await markersDisagree(pool);
    drift.length === 0
      ? ok("is_system and project_type say the same thing about every project")
      : bad(`they disagree about: ${drift.join(", ")}`);

    console.log("");
    console.log("5. the boundary survives the re-labelling");
    /*
     * "This is a taxonomy change, not a permissions change." Run against the real
     * isolation check rather than restated here, because a copy of the rule would
     * pass while the rule itself had been tidied.
     */
    const conn = (await pool.query<{ id: string }>(
      `INSERT INTO connections (slug, kind, scope, project_id, config, health)
       VALUES ($1,'api','project',$2,'{}'::jsonb,'healthy') RETURNING id`,
      [`${SLUG}-secret`, mine])).rows[0].id;
    const fromSystem = await checkConnectionAccess(pool, {
      connectionSlug: `${SLUG}-secret`, projectId: housekeeping,
    });
    !fromSystem.allowed
      ? ok(`a system-scoped task still cannot reach a project's connection: ${fromSystem.reason ?? fromSystem.code}`)
      : bad("THE RE-LABELLING OPENED A BOUNDARY");
    const fromOwn = await checkConnectionAccess(pool, {
      connectionSlug: `${SLUG}-secret`, projectId: mine,
    });
    fromOwn.allowed
      ? ok("while the project that owns it still can, so the rule did not simply get stricter")
      : bad(`the owning project was denied too: ${JSON.stringify(fromOwn)}`);
    await pool.query(`DELETE FROM connections WHERE id = $1`, [conn]);

    console.log("");
    console.log("6. 'what has maintenance been doing?'");
    /*
     * `succeeded`, not `done` - the states are a CHECK constraint on tasks and
     * the constraint is the authority. A fixture inventing its own vocabulary is
     * a test that passes against a schema nobody has.
     */
    for (const [title, state] of [["pruned 3GB of old artifacts", "succeeded"],
      ["rotated the backup key", "succeeded"], ["restore drill", "failed_terminal"]] as const) {
      await pool.query(
        `INSERT INTO tasks (project_id, title, state, priority, lane, updated_at)
         VALUES ($1,$2,$3,'background','system',now())`, [housekeeping, title, state]);
    }
    const activity = await systemActivity(pool, { since: SINCE, limit: 20 });
    const titles = activity.map((a) => a.what);
    titles.includes("pruned 3GB of old artifacts") && titles.includes("rotated the backup key")
      ? ok("it answers with specifics, not a count")
      : bad(`activity: ${titles.join(", ")}`);
    const said = describeSystemActivity(activity, SINCE);
    said.includes("pruned 3GB") && said.includes("failed")
      ? ok(`and says what failed as well as what worked: "${said}"`)
      : bad(`the sentence is not specific enough: ${said}`);
    /*
     * "Nothing ran" is a real answer and sometimes the important one - a
     * reassuring summary of nothing is the failure here.
     */
    describeSystemActivity([], SINCE).includes("Nothing has run")
      ? ok("while an empty week says so plainly rather than reassuring him")
      : bad("an empty period produced a comfortable summary");
    activity.every((a) => a.project !== `${SLUG}-real`)
      ? ok("and it reports on system work only")
      : bad("a real project's task appeared in the maintenance answer");
  } finally {
    for (const id of [mine, housekeeping].filter(Boolean)) {
      await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [id]);
      await pool.query(`DELETE FROM connections WHERE project_id = $1`, [id]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
    }
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
