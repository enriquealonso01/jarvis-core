/**
 * S22's Done-when, on the box: "a phone call produces a merged-ready PR without
 * touching a keyboard."
 *
 * Everything after the carrier is real. A private repo is created with one
 * failing test; a call arrives; what is said is routed by the real classifier
 * into a real heavy task; the real runner reproduces, fixes, tests, commits,
 * pushes; and GitHub is then ASKED whether the pull request exists, rather than
 * our own database being asked whether we think it does.
 *
 * The one simulated part is the carrier: the Telnyx webhooks are synthesised and
 * handed to the real handler, because a genuine inbound call cannot be placed by
 * a script. Everything the call touches after that — the state machine, the
 * runtime, the router, the desk, the harness, GitHub — is the production path.
 *
 *   JARVIS_TELNYX=fake node --import tsx scripts/s22-live-call-to-pr.ts
 *   JARVIS_KEEP_REPO=1 ... to leave the repo behind for inspection
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
import { handleCallEvent, finalizeCall } from "../src/callcontrol.js";

const run = promisify(execFile);
const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 400)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stamp = Date.now().toString(36);
const SLUG = `s22-call-${stamp}`;
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

/** The project's own API credential, exactly as S7 does it. */
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
    projectId, cred.rows[0].id,
  ]);
}

const CCID = `s22-live-${stamp}`;
const b64 = (s: string) => Buffer.from(s).toString("base64");

function ev(type: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: type,
      payload: {
        call_control_id: CCID,
        call_leg_id: `${CCID}-leg`,
        from: process.env.JARVIS_OWNER_E164 ?? "",
        stir_shaken: { attestation: "A" },
        ...extra,
      },
    },
  };
}

async function main(): Promise<void> {
  console.log(`S22 live: ${SLUG}`);

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

  /*
   * And an engine, or the task parks before it starts.
   *
   * S12b made the per-project allowlist fail closed, and B3 confirmed that as
   * the design: a new project has no engine until one is granted. This fixture
   * provisioned the repository, the project, the deploy key and the API
   * credential - and then omitted the grant, so the run parked on "no
   * engineering route is usable here: anthropic_personal is not allowlisted for
   * this project" and never reached the PR the Done-when is about. That is the
   * mirror image of the omission scripts/lib/projectcred.ts exists to stop, and
   * it read exactly like a product failure rather than a missing fixture line.
   */
  await pool.query(
    `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
     VALUES ($1, $2, ARRAY['senior_engineer'])
     ON CONFLICT (auth_profile_id, project_id) DO UPDATE SET allowed_roles = EXCLUDED.allowed_roles`,
    ["anthropic_personal", pid],
  );

  const checkout = await ensureProjectCheckout(pool, pid);
  check("cloned with the deploy key", true, checkout.ok);
  const dir = repoDir(SLUG);

  // One failing test, so the desk has something real to do.
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# s22\n\n## How to test\n    node --test\n");
  await fs.writeFile(
    path.join(dir, "src", "greet.js"),
    "export function greet(name) {\n  return `Hi ${name}`;\n}\n",
  );
  await fs.writeFile(
    path.join(dir, "test", "greet.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert';\n"
    + "import { greet } from '../src/greet.js';\n\n"
    + "test('greets politely', () => {\n"
    + "  assert.strictEqual(greet('Enrique'), 'Good evening, Enrique');\n"
    + "});\n",
  );
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: SLUG, type: "module" }, null, 2));
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=jarvis@local", "-c", "user.name=Jarvis", "commit", "-m", "seed a failing test"], { cwd: dir });

  /*
   * Pushed with the DEPLOY KEY, not with whatever ssh happens to be configured
   * for the operator. The first run of this script pushed with the ambient
   * environment and got "Host key verification failed" — the box has no
   * known_hosts entry for github.com for this user, and it should not need one:
   * every push in this system goes out under the project's own key.
   */
  const { materialiseDeployKey, gitEnv, loadProject, sshUrl } = await import("../src/checkout.js");
  const loaded = await loadProject(pool, pid);
  const mat = await materialiseDeployKey(pool, loaded!);
  if ("error" in mat) throw new Error(mat.error);
  await run("git", ["push", "-q", sshUrl(repo.owner, repo.name), `HEAD:${repo.default_branch}`], {
    cwd: dir, env: gitEnv(mat.sshCommand),
  });
  ok("seeded one failing test on the default branch");

  const red = await run("node", ["--test"], { cwd: dir }).then(() => "GREEN").catch(() => "RED");
  check("and it is RED before Jarvis touches it", "RED", red);

  // ------------------------------------------------------------- the call
  const spoken =
    `In ${SLUG}, the greeting test is failing — greet should return "Good evening, Enrique". `
    + `Fix it and open a pull request.`;

  await handleCallEvent(pool, ev("call.initiated"));
  await handleCallEvent(pool, ev("call.answered"));
  await handleCallEvent(pool, ev("call.playback.ended", { client_state: b64("greeting") }));
  await handleCallEvent(pool, ev("call.transcription", {
    transcription_data: { transcript: spoken, is_final: true },
  }));
  ok("the call said it, out loud, once");

  // The turn is taken after the endpoint window; give it that plus the desk.
  await sleep(40_000);
  await handleCallEvent(pool, ev("call.hangup", { hangup_cause: "normal_clearing" }));
  await finalizeCall(pool, CCID, "the caller hung up").catch(() => undefined);
  ok("and hung up");

  // ------------------------------------------------------- what it produced
  /*
   * Found by the INBOX EVENT, not by the project. The first live run looked
   * only in the project and reported "no task" while a task did exist — the
   * handover had filed one with no project at all. Asking the wrong question
   * turned a real defect into a blank.
   */
  const inbox = await pool.query<{ id: string }>(
    `SELECT id FROM inbox_events WHERE channel = 'phone' AND raw_text = $1
     ORDER BY received_at DESC LIMIT 1`,
    [spoken],
  );
  let task = await pool.query<{ id: string; title: string; objective: string; state: string; lane: string; slug: string | null }>(
    `SELECT t.id, t.title, t.objective, t.state, t.lane, p.slug
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.origin_inbox_id = $1 ORDER BY t.created_at DESC`,
    [inbox.rows[0]?.id ?? null],
  );
  // The router files it during the turn, but a slow desk can push it a little
  // past the hangup; wait rather than declaring it missing.
  for (let i = 0; i < 12 && !task.rowCount; i += 1) {
    await sleep(5_000);
    task = await pool.query(
      `SELECT t.id, t.title, t.objective, t.state, t.lane, p.slug
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.origin_inbox_id = $1 ORDER BY t.created_at DESC`,
      [inbox.rows[0]?.id ?? null],
    );
  }
  check("one sentence, exactly one task", 1, task.rowCount);
  check("in the project the caller named", SLUG, task.rows[0]?.slug);
  truthy("the call produced a task in that project", task.rowCount === 1);
  if (!task.rowCount) throw new Error("no task; nothing further to assert");
  const taskId = task.rows[0].id;
  console.log(`  task ${taskId}: ${task.rows[0].title}`);
  check("heavy work", "heavy", task.rows[0].lane);
  truthy("with a usable objective", task.rows[0].objective.length > 40);

  // ------------------------------------------------------------ the runner
  console.log("  waiting for the runner...");
  let state = task.rows[0].state;
  for (let i = 0; i < 120; i += 1) {
    const r = await pool.query<{ state: string; pr_url: string | null }>(
      "SELECT state, pr_url FROM tasks WHERE id = $1", [taskId]);
    state = r.rows[0].state;
    if (r.rows[0].pr_url || ["succeeded", "failed_terminal", "waiting_for_user"].includes(state)) break;
    await sleep(10_000);
  }
  const done = await pool.query<{ state: string; pr_url: string | null; pr_number: number | null; branch: string | null }>(
    "SELECT state, pr_url, pr_number, branch FROM tasks WHERE id = $1", [taskId]);
  console.log(`  final: state=${done.rows[0].state} branch=${done.rows[0].branch} pr=${done.rows[0].pr_url}`);
  check("the task finished", "succeeded", done.rows[0].state);
  truthy("and a pull request URL was recorded", done.rows[0].pr_url);

  // ---------------------------------------------- ask GitHub, not ourselves
  if (done.rows[0].pr_number) {
    const res = await gh(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${done.rows[0].pr_number}`,
    );
    check("GitHub agrees the pull request exists", 200, res.status);
    const json = (await res.json()) as { state: string; mergeable_state?: string; head: { ref: string } };
    check("it is open", "open", json.state);
    check("from the branch the runner pushed", done.rows[0].branch, json.head.ref);
  }

  // And the report that owed him an answer.
  const note = await pool.query<{ body: string }>(
    `SELECT body FROM notifications_outbox WHERE object_type='task' AND object_id=$1
     ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  truthy("a completion report was queued", note.rowCount === 1);
  truthy("carrying the pull request link", (note.rows[0]?.body ?? "").includes("/pull/"));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    if (created && process.env.JARVIS_KEEP_REPO !== "1") {
      await gh(`https://api.github.com/repos/${created.owner}/${created.repo}`, { method: "DELETE" })
        .then((r) => console.log(`  cleaned up the repo (${r.status})`))
        .catch(() => undefined);
    }
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
