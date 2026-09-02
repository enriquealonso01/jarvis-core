/**
 * S7's first test and S8's N1.5, on real hardware against real GitHub.
 *
 * Creates a private repo with ONE FAILING TEST, lets the runner fix it, and
 * asserts a pull request really exists — fetched back from the GitHub API, not
 * read out of our own database.
 *
 *   node --import tsx scripts/s7-live-pr.ts          # creates and cleans up
 *   JARVIS_KEEP_REPO=1 node ... scripts/s7-live-pr.ts
 *
 * Run on the box: it needs the harness login and the model routes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo, githubProvisionDeployKey } from "../src/github.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../src/crypto.js";
import { readJsonCredential } from "../src/credentials.js";
import { ensureProjectCheckout, repoDir } from "../src/checkout.js";

const run = promisify(execFile);
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
const contains = (m: string, n: string, h: string) => (h.includes(n) ? ok(m) : bad(m, `contains ${n}`, h));

const pool = createPool();
const stamp = Date.now().toString(36);
const SLUG = `s7-live-${stamp}`;
let created: { owner: string; repo: string } | null = null;

async function adminToken(): Promise<string> {
  const r = await pool.query<{ c: string }>(
    `SELECT credential_id AS c FROM auth_profiles WHERE id='github_personal_admin'`,
  );
  return (await readJsonCredential(pool, r.rows[0].c)).api_key;
}

async function gh(url: string, init: RequestInit = {}): Promise<Response> {
  const tok = await adminToken();
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Give the project its OWN API credential row.
 *
 * It holds the same secret as the admin PAT today, because a GitHub
 * fine-grained token is account-scoped and Enrique has one. That is a real
 * limitation and it is written down rather than papered over: the isolation the
 * code enforces is that a project must have its own credential and cannot reach
 * the admin PROFILE through the broker. Per-repository tokens would make the
 * secrets differ too.
 */
async function giveProjectApiCredential(projectId: string): Promise<void> {
  const token = await adminToken();
  const master = loadMasterKey();
  const dek = newDek();
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify({ api_key: token })));
  const dekRow = await pool.query<{ id: string }>(
    "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
    [wrapDek(master, dek)],
  );
  const cred = await pool.query<{ id: string }>(
    `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
     VALUES ($1,$2,$3,$4,'api_key',false) RETURNING id`,
    [dekRow.rows[0].id, ciphertext, nonce, `project:${SLUG}:github`],
  );
  await pool.query(`UPDATE projects SET github_api_credential_id=$2 WHERE id=$1`, [
    projectId,
    cred.rows[0].id,
  ]);
}

async function main(): Promise<void> {
  console.log(`S7 live: ${SLUG}`);

  const repo = await githubCreatePrivateRepo(pool, SLUG);
  if ("error" in repo) throw new Error(`repo: ${repo.error}`);
  created = { owner: repo.owner, repo: repo.name };
  ok(`created private repo ${repo.full_name}`);

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,github_owner,github_repo,default_branch)
     VALUES ($1,$1,'personal','normal',$2,$3,$4) RETURNING id`,
    [SLUG, repo.owner, repo.name, repo.default_branch],
  );
  const pid = project.rows[0].id;

  const key = await githubProvisionDeployKey(pool, pid, repo.owner, repo.name);
  if ("error" in key) throw new Error(`deploy key: ${key.error}`);
  ok(`deploy key registered ${key.fingerprint}`);
  await giveProjectApiCredential(pid);

  const checkout = await ensureProjectCheckout(pool, pid);
  check("cloned with the deploy key", true, checkout.ok);
  const dir = repoDir(SLUG);

  // ---- seed ONE FAILING TEST -------------------------------------------
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# answerkit\n\n## How to test\n    node --test\n");
  await fs.writeFile(path.join(dir, "package.json"),
    '{ "name": "answerkit", "version": "1.0.0", "type": "module", "private": true }\n');
  await fs.writeFile(path.join(dir, "src", "answer.js"), "export function answer() {\n  return 41;\n}\n");
  await fs.writeFile(path.join(dir, "test", "answer.test.js"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { answer } from "../src/answer.js";\n\ntest("the answer is 42", () => {\n  assert.equal(answer(), 42);\n});\n');
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=s@j", "-c", "user.name=Seed", "commit", "-q", "-m", "answerkit"], { cwd: dir });

  const { materialiseDeployKey, gitEnv, loadProject, sshUrl } = await import("../src/checkout.js");
  const p = await loadProject(pool, pid);
  const mat = await materialiseDeployKey(pool, p!);
  if ("error" in mat) throw new Error(mat.error);
  await run("git", ["push", "-q", sshUrl(repo.owner, repo.name), `HEAD:${repo.default_branch}`], {
    cwd: dir, env: gitEnv(mat.sshCommand),
  });
  const red = await run("node", ["--test"], { cwd: dir }).then(() => "GREEN").catch(() => "RED");
  check("the seeded test is RED before Jarvis touches it", "RED", red);

  // ---- the task ---------------------------------------------------------
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     VALUES ($1,'answer() returns the wrong number',
       'test/answer.test.js fails: answer() returns 41 but should return 42. Fix the source so the test passes.',
       'queued','heavy','high') RETURNING id`,
    [pid],
  );
  const tid = t.rows[0].id;
  console.log(`  task ${tid} queued; waiting for the runner…`);

  let state = "";
  for (let i = 0; i < 120; i += 1) {
    const r = await pool.query<{ s: string; ph: string | null; pr: string | null; w: string | null }>(
      `SELECT state AS s, phase AS ph, pr_url AS pr, waiting_reason AS w FROM tasks WHERE id=$1`,
      [tid],
    );
    state = r.rows[0].s;
    if (["succeeded", "failed_terminal", "cancelled"].includes(state) || state.startsWith("waiting")) {
      console.log(`  -> ${state} (phase ${r.rows[0].ph ?? "-"}) ${r.rows[0].w ?? ""}`);
      break;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }

  const row = await pool.query<{ branch: string | null; pr_url: string | null; pr_number: number | null }>(
    `SELECT branch, pr_url, pr_number FROM tasks WHERE id=$1`, [tid],
  );
  const { branch, pr_url, pr_number } = row.rows[0];
  console.log(`  branch=${branch} pr=${pr_url ?? "(none)"}`);

  check("the task succeeded", "succeeded", state);
  truthy("a pull request URL was recorded", pr_url?.startsWith("http"));

  // ---- THE PROOF: ask GitHub, not our own database ----------------------
  if (pr_number) {
    const res = await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr_number}`);
    check("GitHub confirms the pull request exists", 200, res.status);
    if (res.ok) {
      const j = (await res.json()) as { state: string; head: { ref: string }; body: string; title: string };
      check("it is open", "open", j.state);
      check("from Jarvis's branch", branch, j.head.ref);
      contains("and the body carries the evidence", "Verdict", j.body ?? "");
      const files = await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr_number}/files`);
      const list = (await files.json()) as { filename: string }[];
      console.log(`  PR files: ${list.map((f) => f.filename).join(", ")}`);
      truthy("the PR changes the source", list.some((f) => f.filename.startsWith("src/")));
      check("and does not carry Jarvis's scratch", 0, list.filter((f) => f.filename.startsWith(".jarvis/")).length);
    }
  }

  // ---- and the seeded test is green on that branch ----------------------
  if (branch) {
    const tmp = `/var/lib/jarvis/home/verify-${stamp}`;
    await run("git", ["clone", "-q", "--branch", branch, dir, tmp]);
    const green = await run("node", ["--test"], { cwd: tmp }).then(() => "GREEN").catch(() => "RED");
    check("the seeded test is GREEN on the PR's branch", "GREEN", green);
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    if (created && !process.env.JARVIS_KEEP_REPO) {
      await gh(`https://api.github.com/repos/${created.owner}/${created.repo}`, { method: "DELETE" })
        .then((r) => console.log(`cleaned up ${created!.owner}/${created!.repo} -> ${r.status}`))
        .catch(() => undefined);
    } else if (created) {
      console.log(`kept ${created.owner}/${created.repo}`);
    }
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
