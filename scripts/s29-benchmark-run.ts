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
import { collectEvidence, loadCases, scoreRun } from "../src/benchmark.js";

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

  const row = await pool.query<{ branch: string | null; pr_number: number | null }>(
    "SELECT branch, pr_number FROM tasks WHERE id = $1", [taskId]);
  const branch = row.rows[0]?.branch ?? null;

  /*
   * Score against what the agent produced, on its own branch.
   *
   * Checked out into a copy: running the hidden suite inside the project
   * checkout would leave its files behind and score the NEXT run against them.
   */
  let hidden: boolean | null = null;
  let own: boolean | null = null;
  let redGreen: boolean | null = null;
  let changed: string[] = [];
  if (branch) {
    const work = `${dir}-score`;
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    await run("git", ["worktree", "add", "-f", work, branch], { cwd: dir });
    try {
      own = await nodeTest(work);
      const diff = await run("git", ["diff", "--name-only", `${repo.default_branch}...${branch}`], { cwd: dir });
      changed = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      /*
       * Red-green, checked rather than taken on trust.
       *
       * A test that passes with the fix REMOVED asserts nothing about the fix.
       * So the source is reverted to the seed while the tests the agent wrote
       * are kept, and they are run again: they must go red. This is the only
       * dimension that can distinguish a regression test from a test that
       * merely describes whatever the code already does, and it was the last
       * one being reported `null` for want of measuring rather than for want of
       * a way to measure.
       *
       * Null when the agent added no test at all - there is nothing to judge,
       * and scoring that as a failure would double-count the missing test,
       * which `correctness` has already accounted for.
       */
      if (changed.some((f) => f.startsWith("test/"))) {
        await run("git", ["checkout", repo.default_branch, "--", "src/"], { cwd: work });
        const stillPasses = await nodeTest(work);
        redGreen = !stillPasses;
        await run("git", ["checkout", branch, "--", "src/"], { cwd: work }).catch(() => undefined);
      }

      for (const f of await fs.readdir(path.join(c.dir, "hidden"))) {
        await fs.copyFile(path.join(c.dir, "hidden", f), path.join(work, "test", f));
      }
      hidden = await nodeTest(work);
    } finally {
      await run("git", ["worktree", "remove", "--force", work], { cwd: dir }).catch(() => undefined);
    }
  }

  const evidence = await collectEvidence(pool, taskId, {
    hiddenTestsPassed: hidden,
    // The seed tests are part of what the agent inherited, so "its tests pass"
    // and "it did not break what was there" are the same run here.
    regressionTestsPassed: own,
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
      [reg.rows[0].id, RUNTIME, c.id, JSON.stringify({ ...scored, state, evidence })]);
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
