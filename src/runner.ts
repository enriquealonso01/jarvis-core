import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { createPool } from "./db.js";
import { claimTask, transitionTask, writeCheckpoint } from "./jobs.js";
import { raiseIssue } from "./notify.js";
import { sseBroadcast } from "./sse.js";

/**
 * The heavy-lane runner (ADR 015, plan §20.2, §27).
 *
 * This process is the thing Jarvis was missing. Until it existed the heavy lane
 * claimed a task and immediately parked it — every request to actually *do*
 * something died there, which is why the console only ever showed maintenance.
 *
 * It runs on the host under systemd as the unprivileged `jarvis` user, not in
 * the Compose stack, because subscription logins are host-user filesystem state
 * bound to a config directory (ADR 006). It claims from the same tables the
 * containerised system worker uses, so the watchdog, checkpoints, leases and
 * cancel flag all work across both without a second protocol.
 */

const RUNNER_ID = process.env.RUNNER_ID ?? "heavy-1";
const ROOT = process.env.JARVIS_ROOT ?? "/var/lib/jarvis";
const ARTIFACTS = path.join(ROOT, "artifacts");
const WORKTREES = path.join(ROOT, "worktrees");
const PROJECTS = path.join(ROOT, "projects");

/** The watchdog stalls a task after 90s without a heartbeat. Beat well inside that. */
const HEARTBEAT_MS = 20_000;
/** A harness that has emitted nothing for this long is stuck, not thinking. */
const SILENCE_LIMIT_MS = 10 * 60_000;
/** Hard ceiling on a single run, so a runaway agent cannot hold the lane forever. */
const RUN_LIMIT_MS = 45 * 60_000;

type Task = {
  id: string;
  title: string;
  objective: string | null;
  project_id: string | null;
  auth_profile_id: string | null;
  conversation_id: string | null;
};

type Project = {
  id: string;
  slug: string;
  name: string;
  project_type: string;
  confidentiality: string;
  github_owner: string | null;
  github_repo: string | null;
  default_branch: string | null;
};

/**
 * Pick the harness auth profile for this run.
 *
 * Never falls back to "some other profile from the same provider" — plan §31 is
 * explicit that routing is `role + model + provider + auth_profile + policy`,
 * and quietly substituting an account is exactly the isolation break the broker
 * exists to prevent. If the task names a profile, that profile is used or the
 * run does not happen.
 */
async function resolveProfile(
  pool: pg.Pool,
  task: Task,
): Promise<{ id: string; dir: string } | { error: string }> {
  const wanted = task.auth_profile_id;
  const r = await pool.query<{ id: string; dir: string | null; owner: string }>(
    `SELECT id, harness_auth_dir AS dir, owner FROM auth_profiles
     WHERE auth_type = 'subscription_login'
       AND ($1::text IS NULL OR id = $1)
       AND ($1::text IS NOT NULL OR id = 'anthropic_personal')
     LIMIT 1`,
    [wanted],
  );
  const row = r.rows[0];
  if (!row) {
    return { error: wanted ? `auth profile ${wanted} does not exist` : "no anthropic_personal profile" };
  }
  if (!row.dir) {
    return { error: `auth profile ${row.id} has no completed host login` };
  }
  return { id: row.id, dir: row.dir };
}

/**
 * ADR 015 consequence: per-project unix users do not exist yet, so a
 * professional or confidential project cannot be isolated from the personal
 * harness profile on this box. Refuse rather than run it anyway — a run that
 * quietly ignores the classification is worse than one that does not happen.
 */
function isolationRefusal(project: Project | null): string | null {
  if (!project) return null;
  if (project.project_type === "professional") {
    return "professional project: per-project unix user not provisioned (ADR 006 step 5)";
  }
  if (project.confidentiality !== "normal") {
    return `confidentiality=${project.confidentiality}: per-project unix user not provisioned`;
  }
  return null;
}

/**
 * Give the harness somewhere to work.
 *
 * If the project has a local checkout, cut a real git worktree so the run is
 * isolated from any other task on the same repo and produces a branch that can
 * become a PR. If it does not, fall back to a scratch directory — the harness
 * still runs and still produces evidence, it just has no repo to change.
 */
async function prepareWorkspace(
  task: Task,
  project: Project | null,
): Promise<{ dir: string; branch: string | null; isRepo: boolean }> {
  const slug = project?.slug ?? "unscoped";
  const short = task.id.slice(0, 8);
  const dir = path.join(WORKTREES, slug, short);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const repo = project ? path.join(PROJECTS, project.slug, "repo") : null;
  const hasRepo = repo ? await fs.stat(path.join(repo, ".git")).then(() => true, () => false) : false;

  if (!repo || !hasRepo) {
    await fs.mkdir(dir, { recursive: true });
    return { dir, branch: null, isRepo: false };
  }

  const branch = `jarvis/task-${short}`;
  const base = project?.default_branch || "main";
  // Prune first: a worktree left behind by a crashed run holds the path and the
  // branch name, and `worktree add` would fail on both.
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  await git(repo, ["worktree", "remove", "--force", dir]).catch(() => undefined);
  await git(repo, ["branch", "-D", branch]).catch(() => undefined);
  await git(repo, ["fetch", "--quiet", "origin", base]).catch(() => undefined);
  await git(repo, ["worktree", "add", "-b", branch, dir, `origin/${base}`]);
  return { dir, branch, isRepo: true };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]}: ${err.trim() || code}`)),
    );
  });
}

async function cleanupWorkspace(project: Project | null, dir: string, isRepo: boolean): Promise<void> {
  if (!isRepo || !project) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  const repo = path.join(PROJECTS, project.slug, "repo");
  // The branch is deliberately kept: it is the run's output and step 3 turns it
  // into a PR. Only the working directory goes.
  await git(repo, ["worktree", "remove", "--force", dir]).catch(() => undefined);
}

/**
 * Spawn the harness and stream its events.
 *
 * `--output-format stream-json` gives newline-delimited events rather than one
 * blob at the end, which is what makes a long run observable: the transcript
 * lands on disk as it happens, so a crash at minute 30 still leaves 30 minutes
 * of evidence, and silence is detectable while it is happening rather than
 * afterwards.
 */
async function runHarness(args: {
  cwd: string;
  configDir: string;
  prompt: string;
  transcriptPath: string;
  onEvent: (event: Record<string, unknown>) => void;
  signal: AbortSignal;
}): Promise<{ code: number | null; sessionId: string | null; result: string | null; events: number }> {
  await fs.mkdir(path.dirname(args.transcriptPath), { recursive: true });
  const sink = createWriteStream(args.transcriptPath, { flags: "a" });

  const child = spawn(
    "claude",
    [
      "-p",
      args.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // The harness runs against a worktree it is meant to change, so it needs
      // its own tools. What it must NOT get is a path out of the worktree or a
      // credential the broker did not hand it; that is enforced by the unix user
      // and the single config dir, not by this flag.
      "--permission-mode",
      "acceptEdits",
    ],
    {
      cwd: args.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: args.configDir,
        // Never let the harness inherit Jarvis's own database handle.
        DATABASE_URL: "",
        POSTGRES_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let sessionId: string | null = null;
  let result: string | null = null;
  let events = 0;
  let buf = "";

  child.stdout.on("data", (chunk: Buffer) => {
    sink.write(chunk);
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      events += 1;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof event.session_id === "string") sessionId = event.session_id;
      if (event.type === "result" && typeof event.result === "string") result = event.result;
      args.onEvent(event);
    }
  });

  // stderr is not JSON and is not the transcript, but a harness that dies on a
  // login problem says so only here. Keep the tail for the failure summary.
  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString("utf8")).slice(-2000);
  });

  const onAbort = () => child.kill("SIGTERM");
  args.signal.addEventListener("abort", onAbort, { once: true });

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (c) => resolve(c));
  });

  args.signal.removeEventListener("abort", onAbort);
  await new Promise((r) => sink.end(r));

  if (code !== 0 && !result && stderrTail) result = `harness stderr: ${stderrTail.trim()}`;
  return { code, sessionId, result, events };
}

async function registerArtifact(
  pool: pg.Pool,
  projectId: string | null,
  relPath: string,
): Promise<void> {
  const full = path.join(ARTIFACTS, relPath);
  const st = await fs.stat(full).catch(() => null);
  if (!st) return;
  const buf = await fs.readFile(full);
  await pool.query(
    `INSERT INTO artifacts (project_id, path, sha256, mime, bytes, source, quarantine_state, retention_class)
     VALUES ($1, $2, $3, 'application/x-ndjson', $4, 'harness', 'clean', 'build')`,
    [projectId, relPath, crypto.createHash("sha256").update(buf).digest("hex"), st.size],
  );
}

async function park(
  pool: pg.Pool,
  taskId: string,
  state: string,
  reason: string,
  issue: { category: string; title: string; dedupeKey: string; requiredAction: string },
  projectId: string | null,
): Promise<void> {
  await transitionTask(pool, taskId, state, reason, "runner", "lease_until = NULL, lease_owner = NULL");
  await pool.query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, reason]);
  await raiseIssue(pool, {
    category: issue.category,
    service: "harness",
    owner: "user",
    status: "waiting_for_user",
    title: issue.title,
    dedupeKey: issue.dedupeKey,
    taskId,
    projectId,
    evidence: { task_id: taskId, reason },
    requiredAction: issue.requiredAction,
  });
}

async function runHeavyTask(pool: pg.Pool, taskId: string): Promise<void> {
  const t = await pool.query<Task>(
    `SELECT id, title, objective, project_id, auth_profile_id, conversation_id
     FROM tasks WHERE id = $1`,
    [taskId],
  );
  const task = t.rows[0];
  if (!task) return;

  const p = task.project_id
    ? await pool.query<Project>(
        `SELECT id, slug, name, project_type, confidentiality, github_owner, github_repo, default_branch
         FROM projects WHERE id = $1`,
        [task.project_id],
      )
    : null;
  const project = p?.rows[0] ?? null;

  const refusal = isolationRefusal(project);
  if (refusal) {
    await park(
      pool,
      taskId,
      "waiting_for_user",
      refusal,
      {
        category: "security.isolation",
        title: `[isolation] ${project?.slug ?? "project"} cannot run on the shared harness profile`,
        dedupeKey: `isolation.harness.${project?.slug ?? "unknown"}`,
        requiredAction:
          "Provision a per-project unix user and harness-auth directory (ADR 006 step 5) "
          + "before this project may use the heavy lane.",
      },
      task.project_id,
    );
    return;
  }

  const profile = await resolveProfile(pool, task);
  if ("error" in profile) {
    await park(
      pool,
      taskId,
      "waiting_for_provider",
      profile.error,
      {
        category: "provider.cred_expired",
        title: "[harness] no usable subscription login for the heavy lane",
        dedupeKey: "setup.harness.login",
        requiredAction: "Complete the Claude Code host login on the VPS as the jarvis user (ADR 006).",
      },
      task.project_id,
    );
    return;
  }

  const attempt = await pool.query<{ n: number }>(
    `INSERT INTO task_attempts (task_id, n)
     VALUES ($1, COALESCE((SELECT max(n) FROM task_attempts WHERE task_id = $1), 0) + 1)
     RETURNING n`,
    [taskId],
  );
  const n = attempt.rows[0].n;

  let workspace: { dir: string; branch: string | null; isRepo: boolean } | null = null;
  const controller = new AbortController();
  let heartbeat: NodeJS.Timeout | null = null;
  let lastEventAt = Date.now();
  let lastProgressAt = 0;
  const startedAt = Date.now();
  let stopReason: "cancelled" | "silent" | "timeout" | null = null;

  try {
    workspace = await prepareWorkspace(task, project);
    await pool.query(
      `UPDATE tasks SET worktree_path = $2, branch = $3, harness = 'claude_code',
         auth_profile_id = $4, updated_at = now()
       WHERE id = $1`,
      [taskId, workspace.dir, workspace.branch, profile.id],
    );
    await transitionTask(pool, taskId, "running", `harness claude_code on ${profile.id}`, "runner", "heartbeat_at = now()");

    heartbeat = setInterval(() => {
      void (async () => {
        try {
          await pool.query(
            `UPDATE tasks SET heartbeat_at = now(), lease_until = now() + interval '90 seconds'
             WHERE id = $1 AND lease_owner = $2`,
            [taskId, RUNNER_ID],
          );
          const c = await pool.query<{ cancel_requested_at: Date | null }>(
            `SELECT cancel_requested_at FROM tasks WHERE id = $1`,
            [taskId],
          );
          if (c.rows[0]?.cancel_requested_at && !stopReason) {
            stopReason = "cancelled";
            controller.abort();
            return;
          }
          if (Date.now() - lastEventAt > SILENCE_LIMIT_MS && !stopReason) {
            stopReason = "silent";
            controller.abort();
            return;
          }
          if (Date.now() - startedAt > RUN_LIMIT_MS && !stopReason) {
            stopReason = "timeout";
            controller.abort();
          }
        } catch {
          /* a missed heartbeat is what the watchdog is for */
        }
      })();
    }, HEARTBEAT_MS);

    const relTranscript = path.join(project?.slug ?? "unscoped", `task-${task.id.slice(0, 8)}-attempt-${n}.jsonl`);
    const objective = (task.objective ?? task.title).trim();

    const outcome = await runHarness({
      cwd: workspace.dir,
      configDir: profile.dir,
      prompt: objective,
      transcriptPath: path.join(ARTIFACTS, relTranscript),
      signal: controller.signal,
      onEvent: (event) => {
        lastEventAt = Date.now();
        // Reuse `task.updated` rather than adding an event type: the Work view
        // already listens for it, and a harness step *is* a task update. Throttle
        // it — a busy run emits events far faster than any UI needs redrawing.
        if (event.type !== "assistant" && event.type !== "result") return;
        if (Date.now() - lastProgressAt < 5000) return;
        lastProgressAt = Date.now();
        sseBroadcast("task.updated", { id: taskId, state: "running" });
      },
    });

    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;

    await registerArtifact(pool, task.project_id, relTranscript).catch(() => undefined);
    if (outcome.sessionId) {
      await pool.query(`UPDATE tasks SET external_session_id = $2 WHERE id = $1`, [taskId, outcome.sessionId]);
    }

    let head: string | null = null;
    if (workspace.isRepo) {
      head = await git(workspace.dir, ["rev-parse", "HEAD"]).catch(() => null);
      if (head) await pool.query(`UPDATE tasks SET head_sha = $2 WHERE id = $1`, [taskId, head]);
    }

    await writeCheckpoint(pool, taskId, {
      harness: "claude_code",
      attempt: n,
      profile: profile.id,
      worktree: workspace.dir,
      branch: workspace.branch,
      head_sha: head,
      transcript: relTranscript,
      events: outcome.events,
      exit_code: outcome.code,
      stop_reason: stopReason,
      outcome: outcome.code === 0 && !stopReason ? "completed" : "failed",
    });

    if (stopReason === "cancelled") {
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), summary = 'cancelled by operator' WHERE task_id = $1 AND n = $2`,
        [taskId, n],
      );
      await transitionTask(pool, taskId, "cancelled", "cancel observed by runner", "runner", "lease_until = NULL");
      return;
    }

    if (stopReason || outcome.code !== 0) {
      const errorClass = stopReason === "silent" ? "process.stuck" : stopReason === "timeout" ? "agent.loop" : "harness.crash";
      const summary =
        stopReason === "silent"
          ? `no harness output for ${Math.round(SILENCE_LIMIT_MS / 60_000)} minutes`
          : stopReason === "timeout"
            ? `exceeded the ${Math.round(RUN_LIMIT_MS / 60_000)} minute run limit`
            : (outcome.result ?? `harness exited ${outcome.code}`).slice(0, 300);
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), error_class = $3, summary = $4 WHERE task_id = $1 AND n = $2`,
        [taskId, n, errorClass, summary],
      );
      await transitionTask(pool, taskId, "failed_terminal", summary, "runner", "lease_until = NULL");
      await raiseIssue(pool, {
        category: errorClass,
        service: "harness",
        title: `[harness] ${task.title.slice(0, 80)}`,
        dedupeKey: `${errorClass}:${taskId}`,
        taskId,
        projectId: task.project_id,
        evidence: { exit_code: outcome.code, events: outcome.events, transcript: relTranscript, stop_reason: stopReason },
        requiredAction: "Read the run transcript artifact before retrying.",
      });
      return;
    }

    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), summary = $3 WHERE task_id = $1 AND n = $2`,
      [taskId, n, (outcome.result ?? "completed").slice(0, 300)],
    );
    await transitionTask(pool, taskId, "succeeded", "harness run completed", "runner", "lease_until = NULL");
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    const message = err instanceof Error ? err.message : String(err);
    await writeCheckpoint(pool, taskId, { attempt: n, outcome: "failed", error: message }).catch(() => undefined);
    await pool
      .query(`UPDATE task_attempts SET ended_at = now(), error_class = 'worker.crash', summary = $3 WHERE task_id = $1 AND n = $2`, [
        taskId,
        n,
        message.slice(0, 300),
      ])
      .catch(() => undefined);
    await transitionTask(pool, taskId, "failed_terminal", message.slice(0, 300), "runner", "lease_until = NULL").catch(
      () => undefined,
    );
    await raiseIssue(pool, {
      category: "worker.crash",
      service: "harness",
      title: "[runner] heavy task failed before the harness finished",
      dedupeKey: `runner.crash:${taskId}`,
      taskId,
      projectId: task.project_id,
      evidence: { error: message },
    }).catch(() => undefined);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (workspace) await cleanupWorkspace(project, workspace.dir, workspace.isRepo).catch(() => undefined);
    sseBroadcast("task.updated", { id: taskId });
  }
}

async function ensureDirs(): Promise<void> {
  for (const d of [ARTIFACTS, WORKTREES, PROJECTS]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  await ensureDirs();
  console.log(`runner ${RUNNER_ID} starting (heavy lane)`);

  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      stopping = true;
      console.log(`runner ${RUNNER_ID} draining on ${sig}`);
    });
  }

  while (!stopping) {
    try {
      const id = await claimTask(pool, "heavy", RUNNER_ID);
      if (!id) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      await runHeavyTask(pool, id);
    } catch (err) {
      console.error(err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await pool.end().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
