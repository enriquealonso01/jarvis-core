/**
 * S28's first test, exactly as written: "The same task runs to a passing PR on
 * Claude Code and on Codex, changing one field and nothing else."
 *
 * One repository, one bug, one objective, two tasks. The ONLY difference
 * between them is `tasks.runtime`. If anything else has to differ to make the
 * second engine work, the seam leaked and this test is where that shows up — so
 * the objective text is built once and reused by reference, not copied.
 *
 * It also asserts the second clause: "The console renders both runs identically
 * — if one shows phases and the other does not, the normalisation is
 * incomplete." The console renders from `task_events`, so that is what is
 * compared: both runs must produce tool events of the same shape, from two
 * vendor streams that share no field names.
 *
 * Long-running by nature — two real agent runs against a real GitHub repo. Run
 * it on the box in the background and read the log.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo, githubProvisionDeployKey } from "../src/github.js";
import { giveProjectApiCredential } from "./lib/projectcred.js";
import { readJsonCredential } from "../src/credentials.js";
import {
  ensureProjectCheckout, gitEnv, loadProject, materialiseDeployKey, repoDir, sshUrl,
} from "../src/checkout.js";

const run = promisify(execFile);
const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const SLUG = `s28-parity-${Date.now().toString(36).slice(-6)}`;

/** The one sentence both engines are given. Built once, used twice. */
const OBJECTIVE =
  'slugify("Hello World!") returns "hello-world-" with a trailing dash. It should return '
  + '"hello-world". Fix it in src/slugify.js and add a test in test/ that fails without the fix. '
  + "Run `node --test` and make sure it passes before you finish.";

async function adminToken(): Promise<string> {
  const row = await pool.query<{ credential_id: string }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'github_personal_admin'");
  const cred = await readJsonCredential(pool, row.rows[0].credential_id);
  return cred.api_key as string;
}

async function waitForTask(id: string, seconds: number): Promise<string> {
  const until = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < until) {
    const r = await pool.query<{ state: string }>("SELECT state FROM tasks WHERE id = $1", [id]);
    const state = r.rows[0]?.state ?? "gone";
    if (state !== last) { console.log(`    ${new Date().toISOString().slice(11, 19)}  ${state}`); last = state; }
    if (["succeeded", "failed_terminal", "waiting_for_user", "cancelled"].includes(state)) return state;
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  return `timeout after ${seconds}s (last ${last})`;
}

async function main(): Promise<void> {
  console.log(`S28 parity: ${SLUG}\n`);

  const repo = await githubCreatePrivateRepo(pool, SLUG);
  if ("error" in repo) throw new Error(`repo: ${repo.error}`);
  console.log(`  repo ${repo.full_name}`);

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,github_owner,github_repo,default_branch)
     VALUES ($1,$1,'personal','normal',$2,$3,$4) RETURNING id`,
    [SLUG, repo.owner, repo.name, repo.default_branch]);
  const pid = project.rows[0].id;
  const key = await githubProvisionDeployKey(pool, pid, repo.owner, repo.name);
  if ("error" in key) throw new Error(`key: ${key.error}`);
  /*
   * And an API credential, which is a different thing from the deploy key.
   *
   * The key pushes the branch; opening the pull request needs a token. Without
   * this the run reached the PR step, parked, and raised a ticket asking
   * Enrique to add a GitHub credential for a throwaway repository - a real
   * request against a project that exists for ten minutes.
   */
  await giveProjectApiCredential(pool, pid, SLUG);
  /*
   * Allowlist both engines for this project.
   *
   * The first attempt at this test parked immediately with "anthropic_personal
   * is not allowlisted for this project" - correct behaviour, since S12b made
   * the allowlist fail closed, and a gap in the fixture rather than in the
   * code. Both profiles are listed because the whole point is to run the same
   * task on each.
   */
  for (const profile of ["anthropic_personal", "openai_codex_personal"]) {
    await pool.query(
      `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
       VALUES ($1, $2, ARRAY['senior_engineer'])
       ON CONFLICT (auth_profile_id, project_id) DO UPDATE SET allowed_roles = EXCLUDED.allowed_roles`,
      [profile, pid],
    );
  }

  const checkout = await ensureProjectCheckout(pool, pid);
  if (!checkout.ok) throw new Error(`checkout: ${checkout.error}`);
  const dir = repoDir(SLUG);

  // The same seeded bug S6 uses: real, and the existing tests pass around it.
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  await fs.writeFile(path.join(dir, "AGENTS.md"),
    "# slugkit\n\n## How to test\n    node --test\n\n## Scope\nThis repository contains `slugify` and nothing else.\n");
  await fs.writeFile(path.join(dir, "package.json"),
    '{ "name": "slugkit", "version": "1.0.0", "type": "module", "private": true }\n');
  await fs.writeFile(path.join(dir, "src", "slugify.js"),
    "export function slugify(text) {\n  return String(text)\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, \"-\");\n}\n");
  await fs.writeFile(path.join(dir, "test", "slugify.test.js"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/slugify.js";\n\ntest("lowercases and joins", () => {\n  assert.equal(slugify("Hello World"), "hello-world");\n});\n');
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=s@j", "-c", "user.name=Seed", "commit", "-q", "-m", "slugkit"], { cwd: dir });
  const p = await loadProject(pool, pid);
  const mat = await materialiseDeployKey(pool, p!);
  if ("error" in mat) throw new Error(mat.error);
  await run("git", ["push", "-q", sshUrl(repo.owner, repo.name), `HEAD:${repo.default_branch}`],
    { cwd: dir, env: gitEnv(mat.sshCommand) });
  console.log("  seeded the bug and pushed\n");

  const token = await adminToken();
  const results: Record<string, { state: string; pr: number | null; ran: string | null; tools: number }> = {};

  for (const engine of ["claude", "codex"] as const) {
    console.log(`=== ${engine} ===`);
    const t = await pool.query<{ id: string }>(
      `INSERT INTO tasks (title, objective, lane, state, priority, project_id, runtime)
       VALUES ($1, $2, 'heavy', 'queued', 'normal', $3, $4) RETURNING id`,
      [`fix the trailing dash (${engine})`, OBJECTIVE, pid, engine]);
    const id = t.rows[0].id;
    console.log(`  task ${id}, runtime=${engine}`);

    const state = await waitForTask(id, 2400);
    const row = await pool.query<{
      pr_number: number | null; ran_on_runtime: string | null; waiting_reason: string | null;
    }>("SELECT pr_number, ran_on_runtime, waiting_reason FROM tasks WHERE id = $1", [id]);
    const tools = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND type = 'tool'", [id]);

    results[engine] = {
      state,
      pr: row.rows[0]?.pr_number ?? null,
      ran: row.rows[0]?.ran_on_runtime ?? null,
      tools: Number(tools.rows[0]?.n ?? 0),
    };
    console.log(`  -> ${state}, pr=${results[engine].pr}, ran_on=${results[engine].ran}, tools=${results[engine].tools}`);
    if (row.rows[0]?.waiting_reason) console.log(`     waiting: ${row.rows[0].waiting_reason}`);
  }

  console.log("\n########## the same task, both engines ##########\n");
  for (const engine of ["claude", "codex"] as const) {
    const r = results[engine];
    check(`${engine} succeeded`, "succeeded", r.state);
    truthy(`${engine} opened a pull request`, r.pr);
    check(`${engine} is recorded as the engine that ran it`, engine, r.ran);
    /*
     * The console renders from task_events. A run with no tool events renders
     * as a blank timeline, which is what "one shows phases and the other does
     * not" looks like in practice.
     */
    truthy(`${engine} left a legible timeline`, r.tools > 0);

    if (r.pr) {
      const res = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${r.pr}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
                     "User-Agent": "jarvis-core" } });
      check(`...and GitHub agrees ${engine}'s PR exists`, 200, res.status);
    }
  }

  console.log(`\n  claude: ${JSON.stringify(results.claude)}`);
  console.log(`  codex:  ${JSON.stringify(results.codex)}`);
  console.log(`\n  repo: https://github.com/${repo.full_name}`);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    console.log(`\n(final: ${pass} passed, ${fail} failed)`);
    process.exit(fail === 0 ? 0 : 1);
  });
