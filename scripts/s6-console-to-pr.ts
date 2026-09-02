/**
 * S6's Done-when, exactly as written: "N1 passes end to end from a
 * console-created task, and the unreproducible case is handled honestly."
 *
 * Everything up to now has proved the halves separately — a console sentence
 * became a branch, and a task became a pull request — but never both in one
 * run. This does the whole thing:
 *
 *   a sentence typed into a console thread
 *     -> the router files it as heavy work in the right project
 *     -> the runner reproduces, fixes, tests, commits, pushes
 *     -> a second model reviews the diff
 *     -> a pull request appears on GitHub
 *
 * and then asks GitHub whether that pull request exists, rather than asking our
 * own database whether we think it does.
 *
 * The second half of the Done-when is asserted too: an unreproducible report in
 * the same project must NOT produce a pull request, and must say why.
 *
 * Run on the box. Needs the harness login, the model routes, and the GitHub
 * token.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo, githubProvisionDeployKey } from "../src/github.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../src/crypto.js";
import { readJsonCredential } from "../src/credentials.js";
import {
  ensureProjectCheckout,
  gitEnv,
  loadProject,
  materialiseDeployKey,
  repoDir,
  sshUrl,
} from "../src/checkout.js";

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
const SLUG = `n1-console-${stamp}`;
const API = "http://127.0.0.1:8080";
let created: { owner: string; repo: string } | null = null;
let cookie = "";

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

/** Log in as the operator, exactly as the Control Center does. */
async function login(): Promise<void> {
  // The bootstrap credentials file is root-only, which is correct — this runs as
  // the jarvis user, so they are passed in rather than the file being loosened.
  let email = process.env.JARVIS_OPERATOR_EMAIL ?? "";
  let password = process.env.JARVIS_OPERATOR_PASSWORD ?? "";
  if (!email || !password) {
    const raw = await fs.readFile("/var/lib/jarvis/keys/login-once.txt", "utf8");
    email = /email=(.*)/.exec(raw)?.[1]?.trim() ?? "";
    password = /password=(.*)/.exec(raw)?.[1]?.trim() ?? "";
  }
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://jarvis.enriquecodes.com" },
    body: JSON.stringify({ email, password }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`could not log in: ${res.status}`);
}

/** Say something in a console thread and return the reply. */
async function say(conversationId: string, body: string): Promise<string> {
  const res = await fetch(`${API}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://jarvis.enriquecodes.com",
      Cookie: cookie,
    },
    body: JSON.stringify({ body }),
  });
  return res.text();
}

async function giveProjectApiCredential(projectId: string): Promise<void> {
  const token = await adminToken();
  const dek = newDek();
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify({ api_key: token })));
  const dekRow = await pool.query<{ id: string }>(
    "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
    [wrapDek(loadMasterKey(), dek)],
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

async function waitForTask(id: string, seconds = 600): Promise<string> {
  for (let i = 0; i < seconds / 5; i += 1) {
    const r = await pool.query<{ s: string; ph: string | null }>(
      `SELECT state AS s, phase AS ph FROM tasks WHERE id=$1`, [id],
    );
    const s = r.rows[0].s;
    if (["succeeded", "failed_terminal", "cancelled"].includes(s) || s.startsWith("waiting")) {
      console.log(`    -> ${s} (phase ${r.rows[0].ph ?? "-"})`);
      return s;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return "timeout";
}

async function main(): Promise<void> {
  console.log(`N1 console-to-PR: ${SLUG}`);
  await login();

  const repo = await githubCreatePrivateRepo(pool, SLUG);
  if ("error" in repo) throw new Error(`repo: ${repo.error}`);
  created = { owner: repo.owner, repo: repo.name };
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,github_owner,github_repo,default_branch)
     VALUES ($1,$1,'personal','normal',$2,$3,$4) RETURNING id`,
    [SLUG, repo.owner, repo.name, repo.default_branch],
  );
  const pid = project.rows[0].id;
  const key = await githubProvisionDeployKey(pool, pid, repo.owner, repo.name);
  if ("error" in key) throw new Error(`key: ${key.error}`);
  await giveProjectApiCredential(pid);
  const checkout = await ensureProjectCheckout(pool, pid);
  if (!checkout.ok) throw new Error(`checkout: ${checkout.error}`);
  const dir = repoDir(SLUG);

  // A real bug, with tests that pass around it.
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

  // The bug: a trailing separator. Existing tests do not cover it.
  const before = await run("node", ["-e",
    `import("${path.join(dir, "src", "slugify.js")}").then(m=>console.log(m.slugify("Hello World!")))`]);
  console.log(`  slugify("Hello World!") = ${before.stdout.trim()}`);
  check("the bug is real and the suite does not catch it", "hello-world-", before.stdout.trim());
  const suite = await run("node", ["--test"], { cwd: dir }).then(() => "GREEN").catch(() => "RED");
  check("the existing tests pass anyway", "GREEN", suite);

  // ---- THE SENTENCE ------------------------------------------------------
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id,title,channel) VALUES ($1,$2,'web') RETURNING id`,
    [pid, "slugkit"],
  );
  const cid = conv.rows[0].id;
  const before_n = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks WHERE project_id=$1`, [pid]);

  console.log("\n=== typing it in the console ===");
  const reply = await say(cid,
    'slugify("Hello World!") returns "hello-world-" with a trailing dash. It should return "hello-world". '
    + "Please fix it and add a test that fails without the fix.");
  console.log(`  reply: ${reply.slice(0, 220)}`);

  const after = await pool.query<{ id: string; title: string; lane: string; conv: boolean; inbox: boolean }>(
    `SELECT id, title, lane, (conversation_id IS NOT NULL) AS conv, (origin_inbox_id IS NOT NULL) AS inbox
     FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`, [pid]);
  check("the sentence became exactly one new task",
    String(Number(before_n.rows[0].n) + 1),
    String((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks WHERE project_id=$1`, [pid])).rows[0].n));
  const task = after.rows[0];
  truthy("a task exists", Boolean(task));
  check("on the heavy lane", "heavy", task.lane);
  check("with provenance back to the console message", true, task.conv && task.inbox);
  console.log(`  task ${task.id}: ${task.title}`);

  console.log("\n=== waiting for the runner ===");
  const state = await waitForTask(task.id);
  check("the task succeeded", "succeeded", state);

  const row = await pool.query<{ branch: string | null; pr_url: string | null; pr_number: number | null }>(
    `SELECT branch, pr_url, pr_number FROM tasks WHERE id=$1`, [task.id]);
  const { branch, pr_url, pr_number } = row.rows[0];
  console.log(`  branch=${branch}`);
  console.log(`  PR=${pr_url ?? "(none)"}`);

  const phases = await pool.query<{ s: string | null }>(
    `SELECT string_agg(name,' > ' ORDER BY at,id) AS s FROM task_events WHERE task_id=$1 AND type='phase'`,
    [task.id]);
  console.log(`  phases: ${phases.rows[0].s ?? "(none)"}`);
  contains("the loop ran to push", "push", phases.rows[0].s ?? "");
  const review = await pool.query<{ n: string; s: string | null }>(
    `SELECT name AS n, summary AS s FROM task_events WHERE task_id=$1 AND type='review' ORDER BY at LIMIT 1`,
    [task.id]);
  truthy("a review happened", Boolean(review.rows[0]));
  console.log(`  review: ${review.rows[0]?.n ?? "-"} — ${review.rows[0]?.s ?? "-"}`);

  // ---- ASK GITHUB --------------------------------------------------------
  truthy("a pull request URL was recorded", pr_url?.startsWith("http"));
  if (pr_number) {
    const res = await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr_number}`);
    check("GITHUB confirms the pull request exists", 200, res.status);
    const j = (await res.json()) as { state: string; head: { ref: string }; body: string };
    check("it is open", "open", j.state);
    check("from Jarvis's branch", branch, j.head.ref);
    const files = await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr_number}/files`);
    const list = (await files.json()) as { filename: string }[];
    console.log(`  PR files: ${list.map((f) => f.filename).join(", ")}`);
    truthy("it changes the source", list.some((f) => f.filename.startsWith("src/")));
    truthy("and adds a test", list.some((f) => f.filename.startsWith("test/")));
    check("with none of Jarvis's scratch", 0, list.filter((f) => f.filename.startsWith(".jarvis/")).length);
  }

  if (branch) {
    const tmp = `/var/lib/jarvis/home/v-${stamp}`;
    await run("git", ["clone", "-q", "--branch", branch, dir, tmp]);
    const green = await run("node", ["--test"], { cwd: tmp }).then(() => "GREEN").catch(() => "RED");
    check("the suite is GREEN on the PR's branch", "GREEN", green);
    const fixed = await run("node", ["-e",
      `import("${path.join(tmp, "src", "slugify.js")}").then(m=>console.log(m.slugify("Hello World!")))`]);
    check('and slugify("Hello World!") is fixed', "hello-world", fixed.stdout.trim());
    await fs.rm(tmp, { recursive: true, force: true });
  }

  // ---- the other half of the Done-when ----------------------------------
  console.log("\n=== an unreproducible report gets no pull request ===");
  const prsBefore = (await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`)).json();
  const countBefore = ((await prsBefore) as unknown[]).length;
  // The report must be genuinely unreproducible, not merely vague. The first
  // attempt at this asked about "odd output" while the repository still
  // contained the real trailing-dash bug on main — so the harness reproduced
  // something, fixed it, and opened a second PR. That was a correct run against
  // a badly chosen premise, not dishonesty. slugify always returns a string, so
  // "returns undefined" cannot be reproduced by any input.
  const reply2 = await say(cid,
    "A user reports that slugify() occasionally returns undefined instead of a string. "
    + "I have no input that does it and no stack trace. Please fix it.");
  console.log(`  reply: ${reply2.slice(0, 200)}`);
  const t2 = await pool.query<{ id: string }>(
    `SELECT id FROM tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`, [pid]);
  let state2 = "no task";
  if (t2.rows[0] && t2.rows[0].id !== task.id) {
    state2 = await waitForTask(t2.rows[0].id, 420);
    const w = await pool.query<{ w: string | null; v: string | null }>(
      `SELECT t.waiting_reason AS w, a.verdict AS v FROM tasks t
       LEFT JOIN task_attempts a ON a.task_id=t.id WHERE t.id=$1 ORDER BY a.n DESC LIMIT 1`,
      [t2.rows[0].id]);
    console.log(`  state=${state2} verdict=${w.rows[0]?.v ?? "-"} reason=${(w.rows[0]?.w ?? "-").slice(0, 140)}`);
    check("it did not claim success", false, state2 === "succeeded");
  } else {
    ok("the router asked instead of filing work (no task created)");
  }
  const prsAfter = ((await (await gh(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`)).json()) as unknown[]).length;
  check("and NO second pull request was opened", countBefore, prsAfter);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    if (created && !process.env.JARVIS_KEEP_REPO) {
      await gh(`https://api.github.com/repos/${created.owner}/${created.repo}`, { method: "DELETE" })
        .then((r) => console.log(`cleaned up ${created!.owner}/${created!.repo} -> ${r.status}`))
        .catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
