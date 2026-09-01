import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { gitEnv, loadProject, materialiseDeployKey, repoDir, sshUrl } from "./checkout.js";
import { raiseIssue } from "./notify.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Turning a finished run into a pull request a human can read (plan S7).
 *
 * Two credentials are involved and they are not interchangeable. The **deploy
 * key** pushes the branch — it is scoped to one repository and cannot do
 * anything else. The **project's API credential** opens the pull request. The
 * plan's own debug note says a 403 here is nearly always the deploy key being
 * used where the API credential belongs, so they are resolved separately and
 * neither can stand in for the other.
 *
 * The admin PAT is deliberately not a fallback. It can reach every repository
 * on the account, and a project quietly borrowing it is the isolation break the
 * broker exists to prevent — the same one S5 asserts is denied.
 */

export type PrOutcome =
  | { ok: true; number: number; url: string; created: boolean }
  | { ok: false; reason: string; parked: boolean };

type TaskRow = {
  id: string;
  title: string;
  project_id: string | null;
  branch: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
};

/**
 * The evidence a reviewer needs, assembled from what the run actually recorded.
 *
 * Not a summary the model wrote about itself: the phases come from task_events,
 * the verdict from task_attempts, the diffstat from git. A PR body that only
 * repeats the harness's own claims is the thing S6 spent its whole test section
 * refusing to accept.
 */
export async function prBody(pool: pg.Pool, taskId: string, diffstat: string): Promise<string> {
  const t = await pool.query<{ title: string; objective: string | null }>(
    `SELECT title, objective FROM tasks WHERE id = $1`,
    [taskId],
  );
  const attempt = await pool.query<{
    n: number;
    verdict: string | null;
    reproduced: boolean | null;
    confidence: string | null;
    summary: string | null;
  }>(
    `SELECT n, verdict, reproduced, confidence, summary FROM task_attempts
     WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
    [taskId],
  );
  const phases = await pool.query<{ name: string; summary: string | null }>(
    `SELECT name, summary FROM task_events WHERE task_id = $1 AND type = 'phase' ORDER BY at, id`,
    [taskId],
  );
  const a = attempt.rows[0];
  const lines: string[] = [];

  lines.push("## What this changes", "", diffstat.trim() || "(no diffstat available)", "");
  if (t.rows[0]?.objective) {
    lines.push("## Why", "", t.rows[0].objective.trim().slice(0, 1500), "");
  }
  if (phases.rowCount) {
    lines.push("## How it got here", "");
    for (const p of phases.rows) {
      lines.push(`- **${p.name}** — ${(p.summary ?? "").slice(0, 200) || "(no note)"}`);
    }
    lines.push("");
  }
  if (a) {
    lines.push(
      "## Verdict",
      "",
      `- reproduced: **${a.reproduced === null ? "unknown" : a.reproduced ? "yes" : "no"}**`,
      `- verdict: **${a.verdict ?? "unknown"}**`,
      `- confidence: **${a.confidence ?? "unknown"}**`,
      "",
    );
    if (a.summary) lines.push(a.summary.slice(0, 1200), "");
  }
  lines.push("---", "", `Opened by Jarvis for task \`${taskId}\`.`);
  return lines.join("\n");
}

async function projectApiToken(
  pool: pg.Pool,
  projectId: string,
): Promise<{ token: string } | { error: string }> {
  const r = await pool.query<{ cred: string | null }>(
    `SELECT github_api_credential_id AS cred FROM projects WHERE id = $1`,
    [projectId],
  );
  const cred = r.rows[0]?.cred;
  if (!cred) {
    return {
      error:
        "this project has no GitHub API credential. The deploy key can push a branch but cannot "
        + "open a pull request, and the personal admin token is not a substitute — it can reach "
        + "every repository on the account.",
    };
  }
  try {
    const payload = await readJsonCredential(pool, cred);
    const token = payload.api_key ?? payload.token ?? "";
    if (!token) return { error: "the project's GitHub API credential has no token in it" };
    return { token };
  } catch (err) {
    return { error: `the project's GitHub API credential could not be read: ${String(err)}` };
  }
}

async function park(pool: pg.Pool, task: TaskRow, reason: string): Promise<void> {
  await pool
    .query(`UPDATE tasks SET state = 'waiting_for_provider', waiting_reason = $2 WHERE id = $1`, [
      task.id,
      reason.slice(0, 500),
    ])
    .catch(() => undefined);
  // One issue, not one per attempt: a missing credential is a single thing to
  // fix, and a ticket per retry trains you to ignore the queue.
  await raiseIssue(pool, {
    category: "provider.cred_expired",
    service: "github",
    owner: "user",
    status: "waiting_for_user",
    title: "[github] no API credential for this project's pull requests",
    dedupeKey: `github.pr.credential:${task.project_id ?? "none"}`,
    taskId: task.id,
    projectId: task.project_id,
    evidence: { branch: task.branch, reason },
    requiredAction:
      "Add a GitHub API credential for this project on the Connections page. The deploy key "
      + "pushes branches; opening pull requests needs an API token scoped to this repository.",
  }).catch(() => undefined);
}

/**
 * Push the branch and open the pull request for a finished task.
 *
 * Never throws. Every refusal is a recorded reason, because the alternative —
 * an exception in the runner's success path — turns a completed piece of work
 * into a crashed task.
 */
export async function openPullRequestForTask(pool: pg.Pool, taskId: string): Promise<PrOutcome> {
  const tr = await pool.query<TaskRow>(
    `SELECT id, title, project_id, branch, head_sha, pr_number, pr_url FROM tasks WHERE id = $1`,
    [taskId],
  );
  const task = tr.rows[0];
  if (!task) return { ok: false, reason: "no such task", parked: false };

  // Idempotency first, before anything with a side effect.
  if (task.pr_number && task.pr_url) {
    return { ok: true, number: task.pr_number, url: task.pr_url, created: false };
  }
  if (!task.project_id || !task.branch) {
    return { ok: false, reason: "the task has no project or no branch to open a PR from", parked: false };
  }

  const project = await loadProject(pool, task.project_id);
  if (!project?.github_owner || !project.github_repo) {
    // Recorded, not just returned. A silent refusal is indistinguishable from a
    // step that never ran, and the acceptance output then cannot explain itself.
    const reason = "no pull request: this project has no linked repository";
    await pool
      .query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, reason])
      .catch(() => undefined);
    return { ok: false, reason, parked: false };
  }

  const dir = repoDir(project.slug);
  const base = project.default_branch || "main";

  // A branch with no changes gets no pull request, and says so. An empty PR is
  // review work with nothing in it.
  const ahead = await run("git", ["rev-list", "--count", `${base}..${task.branch}`], { cwd: dir })
    .then((r) => Number(r.stdout.trim()))
    .catch(() => 0);
  if (!ahead) {
    const reason = `no pull request: ${task.branch} has no commits that ${base} does not already have`;
    await pool
      .query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, reason])
      .catch(() => undefined);
    return { ok: false, reason, parked: false };
  }

  const token = await projectApiToken(pool, task.project_id);
  if ("error" in token) {
    await park(pool, task, token.error);
    return { ok: false, reason: token.error, parked: true };
  }

  // Push with the DEPLOY KEY. Different credential, different scope.
  const key = await materialiseDeployKey(pool, project);
  if ("error" in key) {
    await park(pool, task, key.error);
    return { ok: false, reason: key.error, parked: true };
  }
  const pushed = await run("git", ["push", "-u", sshUrl(project.github_owner, project.github_repo), `${task.branch}:${task.branch}`], {
    cwd: dir,
    env: gitEnv(key.sshCommand),
    timeout: 120_000,
  })
    .then(() => null)
    .catch((err: { stderr?: string; message?: string }) =>
      (err.stderr || err.message || "push failed").trim().slice(0, 300),
    );
  if (pushed) return { ok: false, reason: `could not push the branch: ${pushed}`, parked: false };

  const diffstat = await run("git", ["diff", "--stat", `${base}...${task.branch}`], { cwd: dir })
    .then((r) => r.stdout)
    .catch(() => "");

  const body = await prBody(pool, taskId, diffstat);
  const res = await fetch(
    `https://api.github.com/repos/${project.github_owner}/${project.github_repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-core",
      },
      body: JSON.stringify({ title: task.title.slice(0, 250), head: task.branch, base, body }),
    },
  ).catch((err: unknown) => ({ ok: false, status: 0, text: async () => String(err) }) as unknown as Response);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const reason = `github refused the pull request (${res.status}): ${detail.slice(0, 200)}`;
    await park(pool, task, reason);
    return { ok: false, reason, parked: true };
  }
  const json = (await res.json()) as { number: number; html_url: string };
  await pool.query(`UPDATE tasks SET pr_number = $2, pr_url = $3 WHERE id = $1`, [
    taskId,
    json.number,
    json.html_url,
  ]);
  await pool
    .query(
      `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1, 'git', 'pull_request', $2)`,
      [taskId, json.html_url],
    )
    .catch(() => undefined);
  await pool
    .query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('runner', 'github.pull_request.open', $1, $2, $3)`,
      [
        `${project.github_owner}/${project.github_repo}#${json.number}`,
        task.project_id,
        JSON.stringify({ task_id: taskId, url: json.html_url, branch: task.branch }),
      ],
    )
    .catch(() => undefined);
  return { ok: true, number: json.number, url: json.html_url, created: true };
}
