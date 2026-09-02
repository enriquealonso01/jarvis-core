import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { connectClient, createPool } from "./db.js";
import { claimTask, transitionTask, writeCheckpoint } from "./jobs.js";
import { raiseIssue } from "./notify.js";
import { sseBroadcast, startSseBridge } from "./sse.js";
import { ARTIFACTS_DIR, BROWSERS_DIR, JARVIS_ROOT, PROJECTS_DIR, WORKTREES_DIR } from "./paths.js";
import { classifyHarnessFailure, retriesExhausted } from "./failures.js";
import { asProjectUser, needsOwnUser, projectUnixUser, provisionCommand, unixUserExists } from "./unixuser.js";
import {
  completedPhases,
  drainPhases,
  nextPhase,
  readOutcome,
  VERDICTS_THAT_ASK,
  VERDICTS_THAT_SUCCEED,
  workflowPrompt,
} from "./workflow.js";

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
const BROWSERS = BROWSERS_DIR;

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
 * A professional or confidential project runs as its own unix user, or it does
 * not run (ADR 006 step 5, decided in ADR 016).
 *
 * This used to be a flat refusal, because the users did not exist. They can be
 * provisioned now, so the question became "has this one been?" — and the answer
 * is asked of the host rather than of the database, because a row saying a user
 * exists is not a user existing.
 *
 * The refusal stays, and it matters: falling back to the shared `jarvis` user
 * would silently return to the state S12 found, where a cross-project read is
 * caught by a tripwire and succeeds anyway. A task that waits is a much better
 * failure than isolation that quietly is not there.
 */
async function isolationRefusal(project: Project | null): Promise<string | null> {
  if (!project) return null;
  if (!needsOwnUser(project)) return null;
  const wanted = projectUnixUser(project.slug);
  if (await unixUserExists(wanted)) return null;
  return (
    `${project.project_type} / ${project.confidentiality}: this project runs as its own unix `
    + `user and ${wanted} does not exist on this host. Run: ${provisionCommand(project.slug)}`
  );
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
  pool: pg.Pool,
  task: Task,
  project: Project | null,
): Promise<{
  dir: string;
  branch: string | null;
  isRepo: boolean;
  baseSha: string | null;
  checkoutError?: string;
}> {
  let checkoutError: string | undefined;
  const slug = project?.slug ?? "unscoped";
  const short = task.id.slice(0, 8);
  const dir = path.join(WORKTREES, slug, short);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const repo = project ? path.join(PROJECTS, project.slug, "repo") : null;
  let hasRepo = repo ? await fs.stat(path.join(repo, ".git")).then(() => true, () => false) : false;

  // "Wire key provisioning to project create and to FIRST USE" (S5). This is
  // first use: a project with a linked repository and no checkout gets one now,
  // cloned with its own deploy key. If that fails the run continues in a scratch
  // directory rather than dying — the harness still produces evidence, and the
  // reason the clone failed is on the task rather than buried in a stack trace.
  if (project && !hasRepo && project.github_owner && project.github_repo) {
    const { ensureProjectCheckout } = await import("./checkout.js");
    const out = await ensureProjectCheckout(pool, project.id);
    if (out.ok) {
      hasRepo = true;
    } else {
      checkoutError = out.error;
    }
  }

  if (!repo || !hasRepo) {
    await fs.mkdir(dir, { recursive: true });
    return { dir, branch: null, isRepo: false, baseSha: null, checkoutError };
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
  // Jarvis's own scratch must be invisible to git. Without this, `.jarvis/`
  // shows as untracked, so a run that deliberately changed NOTHING still reads
  // as "changed", and `git add -A` would commit Jarvis's bookkeeping into
  // Enrique's repository. info/exclude rather than .gitignore: it is per-clone
  // and never appears in the diff.
  // NOTE: in a worktree, `.git` is a FILE pointing at the real gitdir, not a
  // directory. Writing to `<worktree>/.git/info/exclude` therefore fails with
  // ENOTDIR and — because the failure was caught and ignored — the exclude was
  // silently never written. Ask git where its directory actually is.
  // ...and it is the COMMON dir, not the per-worktree one. git reads
  // `$GIT_COMMON_DIR/info/exclude`; `--absolute-git-dir` returns
  // `.git/worktrees/<name>`, which git never consults for excludes. Writing
  // there succeeded and did nothing, so the first real run committed Jarvis's
  // own `.jarvis/` scratch into the project's history.
  const commonDir = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(
    () => null,
  );
  if (commonDir) {
    const info = path.join(commonDir.trim(), "info");
    await fs.mkdir(info, { recursive: true }).catch(() => undefined);
    const exclude = path.join(info, "exclude");
    const current = await fs.readFile(exclude, "utf8").catch(() => "");
    if (!current.includes(".jarvis/")) {
      await fs.appendFile(exclude, `${NEWLINE}.jarvis/${NEWLINE}`).catch(() => undefined);
    }
  }
  const baseSha = await git(dir, ["rev-parse", "HEAD"]).catch(() => null);
  return { dir, branch, isRepo: true, baseSha, checkoutError };
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

/** How long a tool line may be before it stops being a line and starts being a wall. */
const TOOL_DETAIL_LIMIT = 160;
/** Tool events recorded per attempt before the timeline says so and stops. */
export const MAX_TOOL_EVENTS = 300;

/**
 * What a harness event says the harness is doing, in one line per tool call.
 *
 * The interesting argument differs per tool — a path for Read and Write, the
 * command for Bash, the pattern for Grep — and showing the whole input object
 * would put file contents and diffs into the timeline. So this takes the one
 * argument that identifies the call and truncates it.
 *
 * Deliberately no attempt at redaction beyond that: what is here is a filename
 * or a command line, and if a secret is in a command line then it is already in
 * the transcript, the shell history and the process table. The place to fix that
 * is the command, not the display.
 */
export function toolCalls(event: Record<string, unknown>): { name: string; detail: string }[] {
  const message = event.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  const out: { name: string; detail: string }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;
    const input = b.input ?? {};
    let detail = "";
    for (const key of ["command", ...PATH_INPUT_KEYS, "pattern", "url", "query", "description"]) {
      const v = input[key];
      if (typeof v === "string" && v.trim()) {
        detail = v.trim().replace(/\s+/g, " ");
        break;
      }
    }
    if (detail.length > TOOL_DETAIL_LIMIT) detail = `${detail.slice(0, TOOL_DETAIL_LIMIT)}…`;
    out.push({ name: b.name, detail });
  }
  return out;
}

export function escapedPath(
  cwd: string,
  event: Record<string, unknown>,
  /**
   * Paths the run may legitimately touch besides its own worktree.
   *
   * A git worktree's operations reference the repository it was cut from — the
   * common gitdir lives there — so the project's own checkout is not "outside".
   * Without this the guard killed a perfectly correct run: the harness touched
   * /var/lib/jarvis/projects/<slug>/repo and was recorded as an isolation
   * breach. Reaching into ANOTHER project's directory is still a breach; that is
   * the distinction the list draws.
   */
  alsoAllowed: string[] = [],
): string | null {
  const permitted = [cwd, ...alsoAllowed].filter(Boolean);
  const inside = (abs: string) =>
    permitted.some((root) => {
      const rel = path.relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  const message = event.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  for (const block of content) {
    const b = block as { type?: string; input?: Record<string, unknown> };
    if (b.type !== "tool_use" || !b.input) continue;
    for (const key of PATH_INPUT_KEYS) {
      const value = b.input[key];
      if (typeof value !== "string" || value === "") continue;
      const abs = path.resolve(cwd, value);
      if (!inside(abs)) return abs;
    }

    // Shell commands carry their paths in a string, so the loop above never sees
    // them. Scanning that string for anything outside the worktree turned out to
    // be far too blunt: it destroyed two entirely correct runs — one for touching
    // the project's own checkout, one for the literal string "/var/lib/jarvis" —
    // and caught nothing real in either. A containment check with that
    // false-positive rate does not protect anything; it teaches you to switch it
    // off.
    //
    // So it now flags only what would actually be a breach: another project's
    // directory, or the secrets. Real containment is the per-project unix user
    // (ADR 006 step 5, proved in S12); this is a tripwire, not a wall, and a
    // tripwire that fires on ordinary work is worse than none.
    const command = b.input.command;
    if (typeof command === "string" && command) {
      for (const m of command.matchAll(/(?<![\w/-])(\/[\w./@+-]+)/g)) {
        const abs = path.resolve(m[1]);
        if (inside(abs)) continue;
        // Another project's checkout, another project's browser profile,
        // another task's worktree, or the secrets. S12 probed all four and this
        // list only had the first and the last: a `cat` of Beta's browser
        // profile — where Beta's logged-in sessions and cookies live — walked
        // straight past the tripwire, and so did a read of another task's
        // worktree. Both are exactly the cross-project read L9 names.
        const outsideOwn =
          abs.startsWith(`${PROJECTS}${path.sep}`)
          || abs.startsWith(`${BROWSERS}${path.sep}`)
          || abs.startsWith(`${WORKTREES}${path.sep}`)
          || abs.startsWith(`${path.join(ROOT, "keys")}${path.sep}`)
          || abs.startsWith(`${path.join(ROOT, "harness-auth")}${path.sep}`);
        if (outsideOwn) return abs;
      }
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
  /** Besides the worktree — the project's own checkout. */
  allowedPaths?: string[];
  /**
   * The unix user to drop to before exec'ing the harness (ADR 016). Null for a
   * personal project, which shares `jarvis` by ADR 006 step 5.
   */
  asUser?: string | null;
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
        // credential the broker did not hand it; that is enforced by the unix
        // user and the single config dir, not by this flag.
        //
        // `acceptEdits` was wrong, and the first real S6 run proved it: the
        // harness reproduced the bug, found the cause, wrote the fix AND the
        // test — then could not run `node --test`, because acceptEdits permits
        // edits but not execution. A loop whose `checks` phase can never pass
        // cannot honestly finish, and it correctly reported itself blocked.
        //
        // The containment that replaces it is `escapedPath`, which now reads
        // Bash commands as well as path arguments and kills the run on anything
        // reaching outside the worktree.
        "--permission-mode",
        "bypassPermissions",
      ];

  /*
   * Drop to the project's own unix user (ADR 016).
   *
   * This is the wall behind the file tripwire. Everything else in this runner
   * DETECTS a cross-project read; this is what makes the read fail. `sudo`
   * elevates for exactly as long as `setpriv` takes to drop, and the sudoers
   * rule permits nothing else and can never name root.
   */
  const spawned = args.asUser
    ? asProjectUser(args.asUser, command, commandArgs)
    : { command, args: commandArgs };
  if (args.asUser) console.log(`harness runs as ${args.asUser}`);

  const child = spawn(spawned.command, spawned.args, {
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
        const out = escapedPath(args.cwd, event, args.allowedPaths ?? []);
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
  provenance?: { taskId: string; authProfile: string },
): Promise<void> {
  const full = path.join(ARTIFACTS, relPath);
  const st = await fs.stat(full).catch(() => null);
  if (!st) return;
  const buf = await fs.readFile(full);
  // Through recordArtifact, with the provenance attached AT REGISTRATION (S17).
  // The plan: "provenance written later is provenance that will sometimes be
  // missing." This used to be a bare INSERT with no type, no state and no
  // creator, so every run transcript arrived as an anonymous blob.
  const { recordArtifact } = await import("./artifacts.js");
  await recordArtifact(pool, {
    projectId,
    path: relPath,
    type: "test_report",
    mime: "application/x-ndjson",
    bytes: st.size,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    source: "harness",
    retentionClass: "build",
    taskId: provenance?.taskId ?? null,
    agent: "runner",
    harness: HARNESS_SPEC,
    authProfile: provenance?.authProfile ?? null,
  });
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

  const refusal = await isolationRefusal(project);
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

  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | null = null;
  const controller = new AbortController();
  let heartbeat: NodeJS.Timeout | null = null;
  let lastEventAt = Date.now();
  let lastProgressAt = 0;
  const startedAt = Date.now();
  let stopReason: "cancelled" | "silent" | "timeout" | "repeat" | null = null;

  try {
    workspace = await prepareWorkspace(pool, task, project);
    await pool.query(
      `UPDATE tasks SET worktree_path = $2, branch = $3, harness = 'claude_code',
         auth_profile_id = $4, updated_at = now()
       WHERE id = $1`,
      [taskId, workspace.dir, workspace.branch, profile.id],
    );
    if (workspace.checkoutError) {
      await pool.query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [
        taskId,
        `checkout failed, running without a repo: ${workspace.checkoutError}`.slice(0, 500),
      ]).catch(() => undefined);
    }
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
            // Same boundary, same reason: the console should see the loop while
            // it is happening, and a killed run should know where it got to.
            await drainPhases(pool, taskId, workspace.dir, phasesSeen).catch(() => undefined);
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

    // S6: the harness is not handed a bare objective any more. It gets the
    // senior-engineer loop, this project's AGENTS.md, and — if a previous
    // attempt got partway — the phase to resume at, so a killed run does not
    // start over.
    const done = await completedPhases(pool, taskId);
    const resumeFrom = nextPhase(done);
    const agentsMd = await fs
      .readFile(path.join(workspace.dir, "AGENTS.md"), "utf8")
      .catch(() => null);
    // S18b: hand the previous attempt's THINKING forward, not just its progress.
    const { investigationBrief, lastInvestigation } = await import("./investigation.js");
    const previousThinking = resumeFrom ? await lastInvestigation(pool, taskId) : null;
    const objective = workflowPrompt({
      title: task.title,
      objective: (task.objective ?? task.title).trim(),
      agentsMd,
      resumeFrom,
      completed: done,
      brief: investigationBrief(previousThinking),
    });
    const phasesSeen = new Set<string>(done);

    // A cap rather than a throttle. Throttling drops the calls that happen while
    // the run is busiest, which is when you most want to know what it did; a cap
    // keeps the first three hundred in order and then says out loud that it
    // stopped, with the transcript still holding the rest.
    let toolsRecorded = 0;
    let toolCalls_total = 0;
    let lastTool: string | null = null;

    /*
     * Liveness versus progress (S18b, `agent.repeat`).
     *
     * The silence detector catches a run that has stopped saying anything. It
     * cannot catch the more expensive failure: a run that is talking constantly
     * and saying the same thing — re-running the same failing test, re-editing
     * the same line. That looks alive to every check we had, and burns a
     * subscription producing identical non-progress.
     *
     * So: the same tool call with the same argument, this many times with
     * nothing else in between, is not progress.
     */
    const REPEAT_LIMIT = Number(process.env.JARVIS_REPEAT_LIMIT ?? 6);
    let repeatSignature: string | null = null;
    let repeatCount = 0;
    /** Quoted in the Issue, because "it repeated itself" is not actionable. */
    let repeatedAction: string | null = null;

    /*
     * Which unix user this run gets (ADR 006 step 5, decided in ADR 016).
     *
     * A professional or confidential project runs as its own user, so a read of
     * another project's files fails at the filesystem layer rather than merely
     * being caught by the command scanner. If that user has not been
     * provisioned on this host, the task PARKS: falling back to the shared
     * `jarvis` user would be the silent loss of the isolation this exists for,
     * and a silent fallback is worse than a task that waits.
     */
    // Which unix user this run gets. Whether it EXISTS was settled before the
    // task was claimed, by `isolationRefusal`; this only names it.
    const asUser = project && needsOwnUser(project) ? projectUnixUser(project.slug) : null;

    const outcome = await runHarness({
      cwd: workspace.dir,
      configDir: profile.dir,
      prompt: objective,
      transcriptPath: path.join(ARTIFACTS, relTranscript),
      signal: controller.signal,
      allowedPaths: project ? [path.join(PROJECTS, project.slug)] : [],
      asUser,
      onEvent: (event) => {
        lastEventAt = Date.now();

        // S14: what the harness is DOING, not merely that it is doing something.
        //
        // Before this the runner broadcast a bare `task.updated` every five
        // seconds and recorded nothing, so the console could say a task was
        // running and could not say what it had touched. A run was only legible
        // afterwards, by reading the transcript on the box — which is exactly the
        // terminal access S14 is meant to remove the need for.
        //
        // Written as it happens rather than at the end: a run that crashes at
        // minute thirty must still leave thirty minutes of visible work behind.
        for (const call of toolCalls(event)) {
          if (toolsRecorded >= MAX_TOOL_EVENTS) {
            if (toolsRecorded === MAX_TOOL_EVENTS) {
              toolsRecorded += 1;
              void pool
                .query(
                  `INSERT INTO task_events (task_id, type, name, summary)
                   VALUES ($1, 'tool', 'truncated', $2)`,
                  [taskId, `past ${MAX_TOOL_EVENTS} tool calls; the rest are in the transcript`],
                )
                .catch(() => undefined);
            }
            break;
          }
          const signature = `${call.name}:${call.detail}`;
          if (signature === repeatSignature) {
            repeatCount += 1;
            if (repeatCount >= REPEAT_LIMIT && !stopReason) {
              stopReason = "repeat";
              repeatedAction = signature;
              controller.abort();
            }
          } else {
            repeatSignature = signature;
            repeatCount = 1;
          }

          toolsRecorded += 1;
          toolCalls_total += 1;
          void pool
            .query(
              `INSERT INTO task_events (task_id, type, name, summary)
               VALUES ($1, 'tool', $2, $3)`,
              [taskId, call.name.slice(0, 80), call.detail.slice(0, 300)],
            )
            .catch(() => undefined);
          lastTool = `${call.name}: ${call.detail}`.slice(0, 200);
        }

        // Reuse `task.updated` rather than adding an event type: the Work view
        // already listens for it, and a harness step *is* a task update. Throttle
        // the broadcast — a busy run emits events far faster than any UI needs
        // redrawing — but never throttle the ROWS above, or the timeline would
        // have holes exactly where the run was busiest.
        if (event.type !== "assistant" && event.type !== "result") return;
        if (Date.now() - lastProgressAt < 1500) return;
        lastProgressAt = Date.now();
        if (lastTool) {
          void pool
            .query(`UPDATE tasks SET last_tool = $2, progress_note = $3 WHERE id = $1`, [
              taskId,
              lastTool.slice(0, 200),
              `${toolCalls_total} tool call${toolCalls_total === 1 ? "" : "s"} so far`,
            ])
            .catch(() => undefined);
        }
        sseBroadcast("task.updated", { id: taskId, state: "running", tool: lastTool });
      },
    });

    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;

    // Drain before ANY branching. The phases a run reached are the most useful
    // thing it leaves behind when it fails, and a final drain that only ran on
    // the success path lost exactly the ones worth having — a crashed run
    // recorded nothing, so a resumed run had no phase to resume from.
    await drainPhases(pool, taskId, workspace.dir, phasesSeen).catch(() => undefined);

    await registerArtifact(pool, task.project_id, relTranscript, {
      taskId,
      authProfile: profile.id,
    }).catch(() => undefined);
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
    // `.jarvis/` is Jarvis's own scratch — phases and the outcome file — not the
    // project's work. Excluded by pathspec as well as by info/exclude, because
    // one mechanism silently failing (it did: a worktree's .git is a file, so
    // the exclude was never written) should not make an untouched repo look
    // changed.
    const dirty = workspace.isRepo
      ? await git(workspace.dir, ["status", "--porcelain", "--", ".", ":(exclude).jarvis"]).catch(() => "")
      : "";
    const changed = workspace.isRepo
      ? Boolean(dirty) || (head !== null && workspace.baseSha !== null && head !== workspace.baseSha)
      : true;

    /*
     * The six fields that record WHY, not just where (S18b, II.3).
     *
     * `files_modified` comes from git rather than from the agent's account of
     * itself: what it says it changed and what it changed are different claims,
     * and only one of them survives a crash.
     */
    const { investigationState } = await import("./investigation.js");
    const touched = workspace.isRepo
      ? await git(workspace.dir, ["diff", "--name-only", `${workspace.baseSha ?? "HEAD"}`])
          .then((out) => out.split(NEWLINE).map((l) => l.trim()).filter(Boolean).slice(0, 100))
          .catch(() => [])
      : [];
    const investigation = await investigationState(pool, taskId, touched).catch(() => null);

    await writeCheckpoint(pool, taskId, {
      harness: "claude_code",
      attempt: n,
      profile: profile.id,
      ...(investigation ?? {}),
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
    // A harness that stopped early and SAID WHY is not a crash. Read the outcome
    // file before deciding, because the failure branch below never did: a run
    // that honestly reported "not_reproducible" and exited non-zero was recorded
    // as harness.crash, losing the one thing it had to say. Observed live — the
    // real harness stopped at the reproduce phase on an unreproducible report.
    const earlyOutcome = await readOutcome(workspace.dir);
    if (earlyOutcome && VERDICTS_THAT_ASK.has(earlyOutcome.verdict) && !stopReason) {
      const reason = `${earlyOutcome.verdict}: ${earlyOutcome.notes.slice(0, 240)}`;
      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), summary = $3, verdict = $4,
           reproduced = $5, confidence = $6 WHERE task_id = $1 AND n = $2`,
        [taskId, n, reason.slice(0, 300), earlyOutcome.verdict.slice(0, 60),
         earlyOutcome.reproduced, earlyOutcome.confidence.slice(0, 20)],
      ).catch(() => undefined);
      await pool.query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`,
        [taskId, reason.slice(0, 500)]).catch(() => undefined);
      await transitionTask(pool, taskId, "waiting_for_user", reason.slice(0, 300), "runner", "lease_until = NULL");
      await raiseIssue(pool, {
        category: "supervisor",
        service: "harness",
        owner: "user",
        status: "waiting_for_user",
        title: `[review] ${task.title.slice(0, 70)}`,
        dedupeKey: `workflow.report:${taskId}`,
        taskId,
        projectId: task.project_id,
        evidence: {
          verdict: earlyOutcome.verdict,
          reproduced: earlyOutcome.reproduced,
          attempted: earlyOutcome.attempted ?? [],
          missing: earlyOutcome.missing ?? [],
          transcript: relTranscript,
        },
        requiredAction: "Read what it reported. It did not claim to have fixed this.",
      }).catch(() => undefined);
      return;
    }

    if (stopReason || outcome.code !== 0 || outcome.isError) {
      // S11: the class comes from what the run actually said, not from "it
      // exited non-zero". Retrying a subscription limit three times spends the
      // limit three times; retrying a full disk fills it faster.
      const verdict = classifyHarnessFailure({
        stopReason,
        exitCode: outcome.code,
        subtype: outcome.subtype,
        result: outcome.result,
        stderr: outcome.result,
      });
      const summary =
        stopReason === "silent"
          ? `no harness output for ${humanMs(SILENCE_LIMIT_MS)}`
          : stopReason === "timeout"
            ? `exceeded the ${humanMs(RUN_LIMIT_MS)} run limit`
            : `${verdict.summary}: ${(outcome.result?.trim() || `exit ${outcome.code}`).slice(0, 200)}`;

      await pool.query(
        `UPDATE task_attempts SET ended_at = now(), error_class = $3, summary = $4 WHERE task_id = $1 AND n = $2`,
        [taskId, n, verdict.errorClass, summary.slice(0, 300)],
      );

      // Retries are counted per class. A task that crashed twice and then hit a
      // rate limit has not used its rate-limit budget, and counting every
      // failure together would retire it early.
      const prior = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_attempts
         WHERE task_id = $1 AND error_class = $2`,
        [taskId, verdict.errorClass],
      );
      const used = Number(prior.rows[0]?.n ?? 0);
      const canRetry = !verdict.park && !retriesExhausted(used, verdict);

      if (canRetry) {
        // Back onto the queue, keeping every checkpoint and phase so the next
        // attempt resumes where this one stopped rather than starting over.
        await pool.query(
          `UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_until = NULL,
             waiting_reason = $2, updated_at = now() WHERE id = $1`,
          [taskId, `retrying after ${verdict.errorClass} (${used}/${verdict.maxRetries})`],
        );
        await pool.query(
          `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
           VALUES ($1, 'running', 'queued', $2, 'runner')`,
          [taskId, `retry ${used}/${verdict.maxRetries} after ${verdict.errorClass}`],
        ).catch(() => undefined);
        console.log(`task ${taskId} requeued: ${verdict.errorClass} ${used}/${verdict.maxRetries}`);
        return;
      }

      // Parked classes go back to Enrique; exhausted ones fail terminally. A
      // subscription limit is not a broken task and must not read like one.
      const finalState = verdict.park ? verdict.parkState : "failed_terminal";
      await pool.query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [
        taskId,
        summary.slice(0, 500),
      ]).catch(() => undefined);
      await transitionTask(pool, taskId, finalState, summary.slice(0, 300), "runner", "lease_until = NULL");
      const raised = await raiseIssue(pool, {
        category: verdict.errorClass,
        service: "harness",
        owner: verdict.park ? "user" : undefined,
        status: verdict.park ? "waiting_for_user" : undefined,
        title: `[harness] ${task.title.slice(0, 80)}`,
        dedupeKey: `${verdict.errorClass}:${taskId}`,
        taskId,
        projectId: task.project_id,
        evidence: {
          exit_code: outcome.code,
          events: outcome.events,
          transcript: relTranscript,
          stop_reason: stopReason,
          attempts_with_this_class: used,
          // The taxonomy asks for the repeated action to be QUOTED. "It kept
          // repeating itself" is not something anyone can act on; "it ran
          // `npm test -- cart` six times" is.
          ...(repeatedAction ? { repeated_action: repeatedAction } : {}),
        },
        requiredAction: verdict.park
          ? "This will not fix itself by retrying. Read the transcript and clear the cause."
          : "Read the run transcript artifact before retrying.",
      });

      /*
       * S16: a dead credential becomes something Enrique can FIX from a phone.
       *
       * The task is linked to the issue so that repairing the credential resumes
       * this run and every other one parked on the same blocker — gate 4 asks
       * for "all of them, not just the one that hit it first", and without the
       * link the only way to release anything was to release everything.
       *
       * The action request is idempotent per issue, so five tasks hitting the
       * same expired key produce one ticket and one link, not five.
       */
      if (raised.issueId) {
        await pool
          .query("UPDATE tasks SET blocked_by_issue_id = $2 WHERE id = $1", [taskId, raised.issueId])
          .catch(() => undefined);

        if (verdict.errorClass === "provider.cred_expired") {
          const { ensureActionRequest } = await import("./actions.js");
          await ensureActionRequest(pool, {
            issueId: raised.issueId,
            kind: "provide_api_key",
            title: `Reconnect ${profile.id}`,
            message:
              `A run stopped because ${profile.id} would not authenticate: ${summary}. `
              + "Paste a working key and the parked work starts again by itself. "
              + "The key is stored encrypted and used only by Jarvis, for this profile.",
            profileId: profile.id,
          }).catch(() => undefined);
        }
      }
      return;
    }

    // S6: the exit code says the process ended; the outcome file says what it
    // achieved. They are different claims and only one of them is about the bug.
    const outcome2 = await readOutcome(workspace.dir);
    if (outcome2) {
      await pool
        .query(
          `UPDATE task_attempts SET reproduced = $3, verdict = $4, confidence = $5
           WHERE task_id = $1 AND n = $2`,
          [taskId, n, outcome2.reproduced, outcome2.verdict.slice(0, 60), outcome2.confidence.slice(0, 20)],
        )
        .catch(() => undefined);
    }

    // A guess is never a success, however clean the exit. Neither is a verdict
    // that says the work was not done. Both go back to Enrique as a report
    // rather than being filed as a fix nobody asked to review.
    const honestStop =
      !outcome2
        ? "the run finished without writing .jarvis/outcome.json, so what it achieved is unknown"
        : outcome2.guess
          ? `the harness reported this as a GUESS, not an understood fix: ${outcome2.notes.slice(0, 240)}`
          : VERDICTS_THAT_ASK.has(outcome2.verdict)
            ? `${outcome2.verdict}: ${outcome2.notes.slice(0, 240)}`
            : !VERDICTS_THAT_SUCCEED.has(outcome2.verdict)
              ? `unrecognised verdict "${outcome2.verdict}"`
              : null;

    if (honestStop) {
      await pool
        .query(
          `UPDATE task_attempts SET ended_at = now(), summary = $3 WHERE task_id = $1 AND n = $2`,
          [taskId, n, honestStop.slice(0, 300)],
        )
        .catch(() => undefined);
      await pool
        .query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, honestStop.slice(0, 500)])
        .catch(() => undefined);
      await transitionTask(pool, taskId, "waiting_for_user", honestStop.slice(0, 300), "runner", "lease_until = NULL");
      await raiseIssue(pool, {
        category: "supervisor",
        service: "harness",
        owner: "user",
        status: "waiting_for_user",
        title: `[review] ${task.title.slice(0, 70)}`,
        dedupeKey: `workflow.report:${taskId}`,
        taskId,
        projectId: task.project_id,
        evidence: {
          verdict: outcome2?.verdict ?? "none",
          reproduced: outcome2?.reproduced ?? null,
          guess: outcome2?.guess ?? null,
          attempted: outcome2?.attempted ?? [],
          missing: outcome2?.missing ?? [],
          transcript: relTranscript,
        },
        requiredAction: "Read what it reported. It did not claim to have fixed this.",
      }).catch(() => undefined);
      return;
    }

    const successSummary = changed
      ? (outcome.result ?? "completed").slice(0, 300)
      : `no changes: ${(outcome.result ?? "the harness made no edits").slice(0, 260)}`;
    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), summary = $3 WHERE task_id = $1 AND n = $2`,
      [taskId, n, successSummary],
    );
    // S9: a second model reads the diff BEFORE the pull request exists. Blocking
    // findings send the work back through the S3c context path rather than
    // opening a PR that a human then has to reject.
    // S9 says the review happens "before the PR opens", and that is exactly the
    // scope: a change on a project with no linked repository will never become a
    // pull request, so there is no gate for a reviewer to stand in front of.
    // Reviewing it anyway would block local work on a reviewer route that the
    // project has no reason to have configured.
    const willOpenPr = Boolean(project?.github_owner && project.github_repo);
    if (changed && workspace.isRepo && willOpenPr) {
      const { reviewTask, sendBackForRework } = await import("./review.js");
      const review = await reviewTask(pool, taskId).catch((err: unknown) => ({
        ok: false as const,
        findings: [],
        blocking: [],
        error: `review threw: ${err instanceof Error ? err.message : String(err)}`,
        model: "none",
      }));
      if (!review.ok) {
        // A review that did not happen is not a review that passed. The work is
        // held rather than shipped on the strength of an absent opinion.
        const reason = `not reviewed: ${review.error ?? "unknown"}`;
        await pool
          .query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, reason.slice(0, 500)])
          .catch(() => undefined);
        await transitionTask(pool, taskId, "waiting_for_user", reason.slice(0, 300), "runner", "lease_until = NULL");
        await raiseIssue(pool, {
          category: "supervisor",
          service: "reviewer",
          owner: "user",
          status: "waiting_for_user",
          title: `[review] could not review ${task.title.slice(0, 60)}`,
          dedupeKey: `review.unavailable:${taskId}`,
          taskId,
          projectId: task.project_id,
          evidence: { error: review.error ?? null, branch: workspace.branch },
          requiredAction: "The change was not reviewed. Read the diff before merging it.",
        }).catch(() => undefined);
        return;
      }
      if (review.blocking.length) {
        const back = await sendBackForRework(pool, taskId, review.blocking);
        if (back.requeued) {
          console.log(`task ${taskId} sent back: ${back.reason}`);
          return;
        }
        await pool
          .query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [taskId, back.reason.slice(0, 500)])
          .catch(() => undefined);
        await transitionTask(pool, taskId, "waiting_for_user", back.reason.slice(0, 300), "runner", "lease_until = NULL");
        return;
      }
    }

    // S7: a finished run becomes a pull request. Never fatal — a task that did
    // the work and could not open the PR is a completed piece of work with a
    // reason attached, not a crash, and the reason is already recorded by
    // openPullRequestForTask.
    if (changed && workspace.isRepo) {
      const { openPullRequestForTask } = await import("./pullrequest.js");
      const pr = await openPullRequestForTask(pool, taskId).catch((err: unknown) => ({
        ok: false as const,
        reason: `pull request failed: ${err instanceof Error ? err.message : String(err)}`,
        parked: false,
      }));
      if (pr.ok) {
        console.log(`task ${taskId} -> ${pr.url}${pr.created ? "" : " (already open)"}`);
      } else if (pr.parked) {
        // park() already moved the task and raised the issue.
        return;
      }
    }

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
  // Forward only: nothing connects a browser to the runner, and everything it
  // broadcast before this went into an empty set of clients and was lost.
  await startSseBridge(connectClient, { listen: false }).catch(() => undefined);
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
