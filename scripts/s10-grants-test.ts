/**
 * S10 — grants, merge, deploy.
 *
 * The plan asks for each of the eight invalidation conditions to be verified
 * INDIVIDUALLY, so each gets its own fresh grant and its own assertion. A test
 * that fires several at once cannot tell you which one is enforced and which
 * one is decoration.
 *
 * It also asks for the two ends: "fix it, PR it, merge it" on a non-production
 * personal project merges with no second click, and production on a
 * professional project is refused (N6).
 */
import { createPool } from "../src/db.js";
import { checkGrant, consumeGrant, createTaskGrant, levelOf } from "../src/grant.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function project(slug: string, type: string, prod: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,$2,'normal',$3)
     ON CONFLICT (slug) DO UPDATE SET project_type=EXCLUDED.project_type,
       production_status=EXCLUDED.production_status, archived_at=NULL
     RETURNING id`,
    [slug, type, prod],
  );
  return r.rows[0].id;
}

/** A fresh task with a fresh grant, so each condition is tested on its own. */
async function granted(projectId: string, opts: {
  actions?: string[]; sha?: string | null; env?: string | null; repo?: string | null; ttl?: number;
} = {}): Promise<string> {
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     VALUES ($1,'grant subject','x','running','heavy','normal') RETURNING id`,
    [projectId],
  );
  const taskId = t.rows[0].id;
  const g = await createTaskGrant(pool, {
    taskId,
    projectId,
    actions: opts.actions ?? ["merge", "deploy_staging"],
    repo: opts.repo ?? "owner/repo",
    environment: opts.env ?? "staging",
    allowedSha: opts.sha === undefined ? SHA_A : opts.sha,
    ttlMinutes: opts.ttl ?? 120,
  });
  if ("error" in g) throw new Error(g.error);
  return taskId;
}

/** Assert one invalidation condition, on its own grant. */
async function condition(
  n: number,
  name: string,
  projectId: string,
  signals: Parameters<typeof checkGrant>[1]["signals"],
  expectCode: string,
  grantOpts: Parameters<typeof granted>[1] = {},
): Promise<void> {
  const taskId = await granted(projectId, grantOpts);
  const d = await checkGrant(pool, { taskId, action: "merge", signals });
  const detail = d.allowed ? "ALLOWED" : `${d.code}: ${d.reason}`;
  check(`${n}. ${name}`, expectCode, d.allowed ? "ALLOWED" : d.code);
  if (!d.allowed) {
    // The grant must be dead afterwards, not merely refused this once.
    const row = await pool.query<{ inv: Date | null; reason: string | null }>(
      `SELECT invalidated_at AS inv, invalidate_reason AS reason FROM task_grants
       WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`, [taskId]);
    check(`   ...and the grant is invalidated, not just refused`, true, Boolean(row.rows[0].inv));
    const again = await checkGrant(pool, { taskId, action: "merge", signals: { sha: SHA_A } });
    check(`   ...and it stays dead on a clean retry`, false, again.allowed);
  }
  if (process.env.S10_VERBOSE) console.log(`      ${detail}`);
}

async function main(): Promise<void> {
  const personal = await project("s10-personal", "personal", "non_production");
  const professional = await project("s10-professional", "professional", "production");
  const personalProd = await project("s10-personal-prod", "personal", "production");

  console.log("=== the happy path: no second click ===");
  const t = await granted(personal);
  const d = await checkGrant(pool, {
    taskId: t, action: "merge", signals: { sha: SHA_A, environment: "staging", repo: "owner/repo" },
  });
  check("a granted merge on the same commit is allowed", true, d.allowed);
  if (d.allowed) {
    check("at level 2", 2, d.level);
    await consumeGrant(pool, d.grantId, "merge");
    const consumed = await pool.query<{ a: string | null }>(
      `SELECT consumed_action AS a FROM task_grants WHERE id=$1`, [d.grantId]);
    check("and the use is recorded", "merge", consumed.rows[0].a);
  }

  console.log("\n=== the eight conditions, one grant each ===");
  // A NON-production mismatch: "production" would hit the production gate first,
  // which is a different (and stricter) refusal and would leave this condition
  // untested. Testing them one at a time means each case must reach the check it
  // names.
  await condition(1, "project or environment is ambiguous", personal,
    { sha: SHA_A, environment: "dev" }, "ambiguous_target", { env: "staging" });
  await condition(2, "scope materially expands", personal,
    { sha: SHA_A, scopeExpanded: true }, "scope_expanded");
  await condition(3, "a destructive migration appears", personal,
    { sha: SHA_A, destructiveMigration: true }, "destructive_migration");
  await condition(4, "security controls would be weakened", personal,
    { sha: SHA_A, weakensSecurity: true }, "weakens_security");
  await condition(5, "paid billing would be enabled", personal,
    { sha: SHA_A, enablesBilling: true }, "enables_billing");
  await condition(6, "secrets or permissions change", personal,
    { sha: SHA_A, secretsChanged: true }, "secrets_changed");
  await condition(7, "the commit changes after validation", personal,
    { sha: SHA_B }, "sha_changed");
  await condition(8, "the task is resumed after expiry", personal,
    { sha: SHA_A }, "expired", { ttl: -1 });

  console.log("\n=== a grant can never reach Level 3 ===");
  check("merge_production is level 3", 3, levelOf("merge_production"));
  check("deploy_production is level 3", 3, levelOf("deploy_production"));
  const t3 = await granted(personal);
  const d3 = await checkGrant(pool, { taskId: t3, action: "deploy_production", signals: { sha: SHA_A } });
  check("a live grant does not authorise deploy_production", false, d3.allowed);
  if (!d3.allowed) check("it asks for approval instead", "approval_required", d3.code);
  const illegal = await createTaskGrant(pool, {
    taskId: t3, projectId: personal, actions: ["merge", "deploy_production"],
    repo: null, environment: null, allowedSha: null,
  });
  check("and a grant naming a production action is refused outright", true, "error" in illegal);
  if ("error" in illegal) {
    check("rather than quietly narrowed to its legal half", true,
      illegal.error.includes("deploy_production"));
  }

  console.log("\n=== N6: production on a professional project is refused ===");
  const tp = await granted(professional, { env: "production" });
  const dp = await checkGrant(pool, {
    taskId: tp, action: "merge", signals: { sha: SHA_A, environment: "production" },
  });
  check("refused", false, dp.allowed);
  if (!dp.allowed) {
    check("as needing approval", "approval_required", dp.code);
    check("and it says why", true, dp.reason.includes("professional"));
  }

  console.log("\n--- and a personal project in production still needs the flag ---");
  const tpp = await granted(personalProd, { env: "production" });
  const dpp = await checkGrant(pool, {
    taskId: tpp, action: "merge", signals: { sha: SHA_A, environment: "production" },
  });
  check("refused while the flag is off", false, dpp.allowed);
  if (!dpp.allowed) check("naming the flag", true, dpp.reason.includes("nl_grant_may_deploy_production"));
  check("and the flag defaults to false", false,
    (await pool.query<{ f: boolean }>(
      `SELECT nl_grant_may_deploy_production AS f FROM projects WHERE id=$1`, [personalProd])).rows[0].f);

  console.log("\n=== every decision is audited ===");
  const audits = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'grant.%'`);
  check("refusals and allowances both leave a trail", true, Number(audits.rows[0].n) >= 12);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
