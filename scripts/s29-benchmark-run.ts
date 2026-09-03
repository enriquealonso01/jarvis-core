/**
 * Run one benchmark case on one engine, score it from evidence, and record it.
 *
 * The pieces already existed and had never been joined: the corpus knows what a
 * case is, `collectEvidence` reads what a run left behind, `scoreRun` weights
 * it, and `benchmarks` is where a score belongs. This is the join.
 *
 * The scoring half that only this can do is the hidden suite: the tests the
 * agent never saw are copied over whatever it produced and run there. An agent
 * that wrote a test asserting its own behaviour passes its own suite and fails
 * this one, which is the entire reason the corpus keeps them apart.
 *
 *   node --import tsx scripts/s29-benchmark-run.ts <case-id> <runtime>
 *
 * Long-running by nature: a real agent run against a real repository. Run it on
 * the box in the background and read the log.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo, githubProvisionDeployKey } from "../src/github.js";
import { giveProjectApiCredential } from "./lib/projectcred.js";
import { teardownFixtureProject } from "./lib/fixture.js";
import {
  ensureProjectCheckout, gitEnv, loadProject, materialiseDeployKey, repoDir, sshUrl,
} from "../src/checkout.js";
import { collectEvidence, loadCases, measureBranch, scoreRun } from "../src/benchmark.js";

const run = promisify(execFile);
const pool = createPool();

const CASE_ID = process.argv[2];
const RUNTIME = process.argv[3] ?? "claude";
const SLUG = `bench-${CASE_ID}-${Math.random().toString(36).slice(2, 8)}`;

async function waitForTask(id: string, seconds: number): Promise<string> {
  const until = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < until) {
    const r = await pool.query<{ state: string }>("SELECT state FROM tasks WHERE id = $1", [id]);
    const state = r.rows[0]?.state ?? "gone";
    if (state !== last) { console.log(`    ${new Date().toISOString().slice(11, 19)}  ${state}`); last = state; }
    if (["succeeded", "failed_terminal", "waiting_for_user", "cancelled", "stalled"].includes(state)) return state;
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  return `timeout (last ${last})`;
}

/** True when the suite passed. */
async function nodeTest(cwd: string): Promise<boolean> {
  return await run("node", ["--test"], { cwd, timeout: 120_000 }).then(() => true).catch(() => false);
}

let createdProjectId: string | null = null;

async function main(): Promise<void> {
  const cases = await loadCases("benchmarks");
  const c = cases.find((x) => x.id === CASE_ID);
  if (!c) throw new Error(`no case ${CASE_ID}; have ${cases.map((x) => x.id).join(", ")}`);
  console.log(`benchmark: ${c.id} on ${RUNTIME}`);

  const repo = await githubCreatePrivateRepo(pool, SLUG);
  if ("error" in repo) throw new Error(`repo: ${repo.error}`);
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,github_owner,github_repo,default_branch)
     VALUES ($1,$1,'personal','normal',$2,$3,$4) RETURNING id`,
    [SLUG, repo.owner, repo.name, repo.default_branch]);
  const pid = project.rows[0].id;
  createdProjectId = pid;
  const key = await githubProvisionDeployKey(pool, pid, repo.owner, repo.name);
  if ("error" in key) throw new Error(`key: ${key.error}`);
  await giveProjectApiCredential(pool, pid, SLUG);
  await pool.query(
    `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
     SELECT id, $1, ARRAY['senior_engineer'] FROM auth_profiles WHERE auth_type = 'subscription_login'
     ON CONFLICT DO NOTHING`, [pid]);

  const checkout = await ensureProjectCheckout(pool, pid);
  if (!checkout.ok) throw new Error(`checkout: ${checkout.error}`);
  const dir = repoDir(SLUG);

  // The seed, and ONLY the seed: the hidden suite never touches the repository
  // the agent works in.
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  for (const f of await fs.readdir(path.join(c.dir, "seed"))) {
    await fs.copyFile(path.join(c.dir, "seed", f), path.join(dir, "src", f));
  }
  await fs.writeFile(path.join(dir, "package.json"),
    `{ "name": "${c.id}", "version": "1.0.0", "type": "module", "private": true }\n`);
  await fs.writeFile(path.join(dir, "AGENTS.md"),
    `# ${c.id}\n\n## How to test\n    node --test\n`);
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=b@j", "-c", "user.name=Bench", "commit", "-q", "-m", c.id], { cwd: dir });
  const p = await loadProject(pool, pid);
  const mat = await materialiseDeployKey(pool, p!);
  if ("error" in mat) throw new Error(mat.error);
  await run("git", ["push", "-q", sshUrl(repo.owner, repo.name), `HEAD:${repo.default_branch}`],
    { cwd: dir, env: gitEnv(mat.sshCommand) });
  console.log("  seeded and pushed");

  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (title, objective, lane, state, priority, project_id, runtime)
     VALUES ($1, $2, 'heavy', 'queued', 'normal', $3, $4) RETURNING id`,
    [`${c.title} (${RUNTIME})`, c.objective, pid, RUNTIME]);
  const taskId = t.rows[0].id;
  console.log(`  task ${taskId}, runtime=${RUNTIME}`);
  const state = await waitForTask(taskId, 2400);

  const row = await pool.query<{
    branch: string | null; pr_number: number | null; waiting_reason: string | null;
  }>("SELECT branch, pr_number, waiting_reason FROM tasks WHERE id = $1", [taskId]);
  const branch = row.rows[0]?.branch ?? null;
  /*
   * Why it stopped, kept with the score.
   *
   * The teardown deletes the task, so a row saying "codex 0.65" survives while
   * the reason it scored that does not. The first two-engine comparison was
   * unreadable within minutes: codex lost a point for opening no pull request,
   * and whether that was engineering or the known push problem could no longer
   * be established from anything left behind.
   */
  const reason = row.rows[0]?.waiting_reason ?? null;
  if (reason) console.log(`  reason: ${reason.slice(0, 160)}`);

  /*
   * Score against what the agent produced, on its own branch.
   *
   * Checked out into a copy: running the hidden suite inside the project
   * checkout would leave its files behind and score the NEXT run against them.
   */
  /*
   * Measured by the shared path, not a copy of it.
   *
   * s29-fluent-fraud.ts scores a deliberately worthless branch through this
   * same function. A second implementation here would let the suite pass
   * frauds while the fraud check reported everything was fine.
   */
  let hidden: boolean | null = null;
  let own: boolean | null = null;
  let redGreen: boolean | null = null;
  let changed: string[] = [];
  let baseHadTests = false;
  if (branch) {
    const m = await measureBranch({
      dir, base: repo.default_branch, branch, caseDir: c.dir, runTests: nodeTest,
    });
    hidden = m.hidden;
    own = m.own;
    redGreen = m.redGreen;
    changed = m.changed;
    baseHadTests = m.baseHadTests;
  }

  const evidence = await collectEvidence(pool, taskId, {
    hiddenTestsPassed: hidden,
    // The seed tests are part of what the agent inherited, so "its tests pass"
    // and "it did not break what was there" are the same run here.
    // Only when the base had tests to break. Feeding this the same boolean as
    // correctness paid a run twice for one self-certified fact.
    regressionTestsPassed: baseHadTests ? own : null,
    ownTestsPassed: own,
    redGreenVerified: redGreen,
    filesChanged: changed,
    expectedFiles: c.expectedFiles,
    tokens: null,
  });
  const scored = scoreRun(evidence);

  const reg = await pool.query<{ id: string }>(
    `SELECT id FROM model_registry WHERE $1 = ANY (role_assignments) AND approval_state = 'approved'
     ORDER BY route_order LIMIT 1`, ["senior_engineer"]);
  if (reg.rows[0]) {
    await pool.query(
      `INSERT INTO benchmarks (model_registry_id, harness, suite, scores)
       VALUES ($1, $2, $3, $4)`,
      [reg.rows[0].id, RUNTIME, c.id, JSON.stringify({ ...scored, state, reason, evidence })]);
  }

  console.log(`  state=${state} hidden=${hidden} own=${own} redGreen=${redGreen} files=${changed.length}`);
  console.log(`  overall=${scored.overall === null ? "null" : scored.overall.toFixed(2)}  unscored=${scored.unscored.join(",")}`);
  console.log(`  scores=${JSON.stringify(scored.scores)}`);
  console.log(`  repo: https://github.com/${repo.full_name}`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(async () => {
    if (createdProjectId && process.env.KEEP !== "1") {
      const t = await teardownFixtureProject(pool, createdProjectId).catch(() => null);
      if (t) console.log(`  cleaned up ${Object.entries(t.removed).map(([k, v]) => `${k}:${v}`).join(" ")}`);
    }
    await pool.end().catch(() => undefined);
  });
