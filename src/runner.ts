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
import { ARTIFACTS_DIR, JARVIS_ROOT, PROJECTS_DIR, WORKTREES_DIR } from "./paths.js";

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

const NEWLINE = "\n";

/**
 * Set the moment systemd asks us to stop.
 *
 * `KillMode=control-group` is systemd's default, so a `systemctl restart` sends
 * SIGTERM to the whole cgroup — the harness included. The harness then dies with
 * 143 and, without this flag, the runner cannot tell its own shutdown from a
 * crash: it recorded `harness.crash`, marked the task failed_terminal, and threw
 * away everything the run had done. Observed on Netcup, which is the entire
 * reason S4 says to test a mid-run restart on real hardware.
 */
let draining = false;

const RUNNER_ID = process.env.RUNNER_ID ?? "heavy-1";
const ROOT = JARVIS_ROOT;
const ARTIFACTS = ARTIFACTS_DIR;
const WORKTREES = WORKTREES_DIR;
const PROJECTS = PROJECTS_DIR;

/** Rounding a 6-second test limit to "0 minutes" makes the failure message a lie. */
function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60_000)} minutes`;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The three timers are env-overridable for one reason: the silence limit is ten
 * minutes and the run limit is forty-five, so testing them at their production
 * values costs an hour per run and nobody ever does it. S1's variants set them
 * to seconds. The defaults are the production values, so the box is unaffected.
 */
/** The watchdog stalls a task after 90s without a heartbeat. Beat well inside that. */
const HEARTBEAT_MS = envMs("JARVIS_HEARTBEAT_MS", 20_000);
/** A harness that has emitted nothing for this long is stuck, not thinking. */
const SILENCE_LIMIT_MS = envMs("JARVIS_SILENCE_LIMIT_MS", 10 * 60_000);
/** Hard ceiling on a single run, so a runaway agent cannot hold the lane forever. */
const RUN_LIMIT_MS = envMs("JARVIS_RUN_LIMIT_MS", 45 * 60_000);

/**
 * `JARVIS_HARNESS` selects what actually gets spawned. `claude` is the default
 * and the only thing production ever uses; `fake` and `fake:<variant>` spawn
 * `scripts/fake-harness.mjs`, which speaks the same stream-json protocol without
 * a subscription or a network.
 */
const HARNESS_SPEC = process.env.JARVIS_HARNESS ?? "claude";
const FAKE_HARNESS = HARNESS_SPEC === "fake" || HARNESS_SPEC.startsWith("fake:");
const FAKE_VARIANT = FAKE_HARNESS ? (HARNESS_SPEC.split(":")[1] ?? "ok") : null;

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
): Promise<{ dir: string; branch: string | null; isRepo: boolean; baseSha: string | null }> {
  const slug = project?.slug ?? "unscoped";
  const short = task.id.slice(0, 8);
  const dir = path.join(WORKTREES, slug, short);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const repo = project ? path.join(PROJECTS, project.slug, "repo") : null;
  const hasRepo = repo ? await fs.stat(path.join(repo, ".git")).then(() => true, () => false) : false;

  if (!repo || !hasRepo) {
    await fs.mkdir(dir, { recursive: true });
    return { dir, branch: null, isRepo: false, baseSha: null };
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
  const baseSha = await git(dir, ["rev-parse", "HEAD"]).catch(() => null);
  return { dir, branch, isRepo: true, baseSha };
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
 * Did the harness just try to touch something outside its worktree?
 *
 * Claude Code announces every file it is about to touch as a `tool_use` block
 * with a path in the input, so the escape is visible in the stream before its
 * consequences are. This is detection, not containment: the kernel-level block
 * is a per-project unix user (ADR 006 step 5, proved in S11), and until that
 * exists the runner already refuses professional and confidential projects
 * outright. What this adds is that a personal run which reaches outside its
 * worktree is stopped, its branch is discarded, and the attempt is audited
 * rather than silently succeeding.
 */
const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path", "target_file", "edit_file_path"];

export function escapedPath(cwd: string, event: Record<string, unknown>): string | null {
  const message = event.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  for (const block of content) {
    const b = block as { type?: string; input?: Record<string, unknown> };
    if (b.type !== "tool_use" || !b.input) continue;
    for (const key of PATH_INPUT_KEYS) {
      const value = b.input[key];
      if (typeof value !== "string" || value === "") continue;
      const abs = path.resolve(cwd, value);
      const rel = path.relative(cwd, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return abs;
    }
  }
  return null;
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
}): Promise<{
  code: number | null;
  sessionId: string | null;
  result: string | null;
  events: number;
  escape: string | null;
  subtype: string | null;
  isError: boolean;
}> {
  await fs.mkdir(path.dirname(args.transcriptPath), { recursive: true });
  const sink = createWriteStream(args.transcriptPath, { flags: "a" });

  const command = FAKE_HARNESS ? process.execPath : "claude";
  const commandArgs = FAKE_HARNESS
    ? [path.resolve(process.cwd(), "scripts/fake-harness.mjs"), args.prompt]
    : [
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
      ];

  const child = spawn(command, commandArgs, {
    cwd: args.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: args.configDir,
      JARVIS_FAKE_VARIANT: FAKE_VARIANT ?? "",
      // Never let the harness inherit Jarvis's own database handle.
      DATABASE_URL: "",
      POSTGRES_PASSWORD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Held on an object, not as plain `let`s: they are only ever assigned inside
  // the stdout callback, which TypeScript's control-flow analysis cannot see, so
  // as locals it narrows every one of them to its initialiser.
  const seen: { sessionId: string | null; result: string | null; subtype: string | null; isError: boolean } = {
    sessionId: null,
    result: null,
    subtype: null,
    isError: false,
  };
  let events = 0;
  let buf = "";
  let escape: string | null = null;

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
      if (typeof event.session_id === "string") seen.sessionId = event.session_id;
      if (event.type === "result") {
        // Observed from a real `claude -p --output-format stream-json` run
        // (S4 Debug, "capture one raw run and read it"): a failing result has
        // `is_error: true`, a `subtype` naming the failure, and `result: ""`.
        // The empty string is the trap — it is not nullish, so `??` never fired
        // and a failed task was recorded with a blank summary.
        if (typeof event.result === "string") seen.result = event.result;
        if (typeof event.subtype === "string") seen.subtype = event.subtype;
        if (typeof event.is_error === "boolean") seen.isError = event.is_error;
      }
      if (!escape) {
        const out = escapedPath(args.cwd, event);
        if (out) {
          escape = out;
          child.kill("SIGKILL");
        }
      }
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

  // Build the failure explanation from whatever the run actually left behind,
  // in descending order of usefulness. An empty string counts as nothing.
  if (!seen.result || !seen.result.trim()) {
    seen.result =
      seen.subtype && seen.subtype !== "success"
        ? `harness reported ${seen.subtype}`
        : stderrTail.trim()
          ? `harness stderr: ${stderrTail.trim()}`
          : null;
  }
  return {
    code,
    sessionId: seen.sessionId,
    result: seen.result,
    events,
    escape,
    subtype: seen.subtype,
    isError: seen.isError,
  };
}


/**
 * Hand the harness anything Enrique said since the run started (plan S3c).
 *
 * Pulled, never pushed. A push to a process that is mid-harness-call has
 * nowhere to land, so the runner looks for pending context on every heartbeat
 * and writes it into the worktree, where the harness can read it like any other
 * file. The run is not restarted, not signalled and not interrupted; it simply
 * finds more to work with than it had a minute ago.
 *
 * Marked delivered only after the file exists. A row marked delivered whose
 * file was never written would be his words, lost, with a timestamp claiming
 * otherwise.
 */
async function deliverPendingContext(
  pool: pg.Pool,
  taskId: string,
  worktree: string,
  attempt: number,
): Promise<number> {
  const pending = await pool.query<{ id: string; body: string; created_at: Date }>(
    `SELECT id, body, created_at FROM task_context
     WHERE task_id = $1 AND delivered_at IS NULL
     ORDER BY created_at`,
    [taskId],
  );
  if (!pending.rows.length) return 0;

  const dir = path.join(worktree, ".jarvis", "context");
  await fs.mkdir(dir, { recursive: true });
  let written = 0;
  for (const row of pending.rows) {
    const file = path.join(dir, `${row.id}.md`);
    try {
      await fs.writeFile(
        file,
        [
          "# Additional context from Enrique",
          "",
          `Sent at ${new Date(row.created_at).toISOString()}, while this task was already running.`,
          "",
          row.body,
          "",
        ].join(NEWLINE),
      );
    } catch {
      // Leave it pending. The next heartbeat tries again.
      continue;
    }
    await pool.query(
      `UPDATE task_context SET delivered_at = now(), delivered_attempt = $2 WHERE id = $1`,
      [row.id, attempt],
    );
    written += 1;
  }
  return written;
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

  let workspace: { dir: string; branch: string | null; isRepo: boolean; baseSha: string | null } | null = null;
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
          // The checkpoint boundary S3c talks about. The heartbeat is already
          // the runner's periodic look at the outside world, so it is where new
          // context is noticed too — no second timer, no signal handler, and
          // nothing that has to reach a process mid-call.
          if (workspace && !stopReason) {
            const delivered = await deliverPendingContext(pool, taskId, workspace.dir, n);
            if (delivered) {
              await writeCheckpoint(pool, taskId, {
                attempt: n,
                outcome: "context_delivered",
                context_files: delivered,
              }).catch(() => undefined);
            }
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

    // "It ran and exited 0" is not the same as "it did something". A harness that
    // read the code, decided nothing was needed and stopped is a legitimate
    // outcome, but it has to be reported as one rather than shown to Enrique as
    // a finished task with an invisible result.
    const dirty = workspace.isRepo
      ? await git(workspace.dir, ["status", "--porcelain"]).catch(() => "")
      : "";
    const changed = workspace.isRepo
      ? Boolean(dirty) || (head !== null && workspace.baseSha !== null && head !== workspace.baseSha)
      : true;

    await writeCheckpoint(pool, taskId, {
      harness: "claude_code",
      attempt: n,
      profile: profile.id,
      worktree: workspace.dir,
      branch: workspace.branch,
      base_sha: workspace.baseSha,
      head_sha: head,
      transcript: relTranscript,
      events: outcome.events,
      exit_code: outcome.code,
      result_subtype: outcome.subtype,
      is_error: outcome.isError,
      stop_reason: draining && !stopReason ? "drained" : stopReason,
      escape_attempt: outcome.escape,
      changed,
      outcome: outcome.escape ? "blocked" : outcome.code === 0 && !stopReason ? "completed" : "failed",
    });

    if (outcome.escape) {
      // Blocked: the run was killed the moment the path appeared in the stream,
      // and its branch is thrown away so nothing it produced can reach a PR.
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, project_id, metadata)
         VALUES ('runner', 'harness.escape_blocked', $1, $2, $3)`,
        [outcome.escape, task.project_id, JSON.stringify({
          task_id: taskId,
          worktree: workspace.dir,
          attempted_path: outcome.escape,
          branch: workspace.branch,
          transcript: relTranscript,
        })],
      );
      if (workspace.branch && project) {
        await git(path.join(PROJECTS, project.slug, "repo"), ["worktree", "remove", "--force", workspace.dir]).catch(() => undefined);
        await git(path.join(PROJECTS, project.slug, "repo"), ["branch", "-D", workspace.branch]).catch(() => undefined);
      }
      const summary = `harness reached outside its worktree: ${outcome.escape}`;
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), error_class = 'security.isolation', summary = $3 WHERE task_id = $1 AND n = $2`,
        [taskId, n, summary.slice(0, 300)],
      );
      await transitionTask(pool, taskId, "failed_terminal", summary.slice(0, 300), "runner", "lease_until = NULL");
      await raiseIssue(pool, {
        category: "security.isolation",
        service: "harness",
        title: `[isolation] harness wrote outside the worktree on ${task.title.slice(0, 60)}`,
        dedupeKey: `security.isolation:${taskId}`,
        taskId,
        projectId: task.project_id,
        evidence: { attempted_path: outcome.escape, worktree: workspace.dir, transcript: relTranscript },
        requiredAction: "Read the transcript. The branch was discarded; do not retry until the cause is understood.",
      });
      return;
    }

    // Shutting down is not an outcome. The task keeps its `running` state and its
    // stale heartbeat, and the watchdog does stalled -> recovering -> queued from
    // the checkpoint — which is exactly the recovery the plan asks for. Deciding
    // anything here would be deciding it on behalf of a process that is about to
    // stop existing.
    if (draining && !stopReason) {
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), summary = $3 WHERE task_id = $1 AND n = $2`,
        [taskId, n, "runner drained mid-run; left for the watchdog to requeue"],
      ).catch(() => undefined);
      console.log(`runner ${RUNNER_ID} leaving task ${taskId} for the watchdog`);
      return;
    }

    if (stopReason === "cancelled") {
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), summary = 'cancelled by operator' WHERE task_id = $1 AND n = $2`,
        [taskId, n],
      );
      await transitionTask(pool, taskId, "cancelled", "cancel observed by runner", "runner", "lease_until = NULL");
      return;
    }

    // `is_error` is checked alongside the exit code, not instead of it. The
    // capture showed them agreeing, but a harness that ever reports an error and
    // still exits 0 would otherwise be recorded as a success.
    if (stopReason || outcome.code !== 0 || outcome.isError) {
      const errorClass = stopReason === "silent" ? "process.stuck" : stopReason === "timeout" ? "agent.loop" : "harness.crash";
      const summary =
        stopReason === "silent"
          ? `no harness output for ${humanMs(SILENCE_LIMIT_MS)}`
          : stopReason === "timeout"
            ? `exceeded the ${humanMs(RUN_LIMIT_MS)} run limit`
            : (outcome.result?.trim() || `harness exited ${outcome.code}`).slice(0, 300);
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

    const successSummary = changed
      ? (outcome.result ?? "completed").slice(0, 300)
      : `no changes: ${(outcome.result ?? "the harness made no edits").slice(0, 260)}`;
    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), summary = $3 WHERE task_id = $1 AND n = $2`,
      [taskId, n, successSummary],
    );
    await transitionTask(
      pool,
      taskId,
      "succeeded",
      changed ? "harness run completed" : "harness run completed with an empty diff",
      "runner",
      "lease_until = NULL",
    );
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
      draining = true;
      console.log(`runner ${RUNNER_ID} draining on ${sig}`);
    });
  }

  // `RUNNER_ONCE=1` claims one task, runs it, and exits. Only the test harness
  // uses it: a daemon that never returns cannot be asserted on, and S1's whole
  // purpose is that each variant produces one observable outcome.
  const once = process.env.RUNNER_ONCE === "1";
  const idleDeadline = Date.now() + envMs("RUNNER_IDLE_EXIT_MS", 30_000);
  while (!stopping) {
    try {
      const id = await claimTask(pool, "heavy", RUNNER_ID);
      if (!id) {
        if (once && Date.now() > idleDeadline) {
          console.log(`runner ${RUNNER_ID} idle, exiting (RUNNER_ONCE)`);
          break;
        }
        await new Promise((r) => setTimeout(r, once ? 500 : 3000));
        continue;
      }
      await runHeavyTask(pool, id);
      if (once) break;
    } catch (err) {
      console.error(err);
      if (once) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await pool.end().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
