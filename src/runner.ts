import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  HARNESS_TO_RUNTIME, RUNTIMES, runtimeAvailable, runtimeFor, runtimeForHarness,
  type AgentRuntime, type RuntimeEvent,
} from "./runtime.js";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import { scrubString } from "./scrubber.js";
import path from "node:path";
import type pg from "pg";
import { connectClient, createPool } from "./db.js";
import { claimTask, transitionTask, writeCheckpoint } from "./jobs.js";
import { raiseIssue } from "./notify.js";
import { sseBroadcast, startSseBridge } from "./sse.js";
import { ARTIFACTS_DIR, BROWSERS_DIR, JARVIS_ROOT, PROJECTS_DIR, WORKTREES_DIR } from "./paths.js";
import { classifyHarnessFailure, retriesExhausted } from "./failures.js";
import { asProjectUser, needsOwnUser, projectUnixUser, provisionCommand, unixUserExists } from "./unixuser.js";
import { egressArgv, planEgress } from "./egress.js";
import { engineerLadder, noteRateLimited, noteServed, retryAfterFrom } from "./quota.js";
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
/**
 * S28: the host's default runtime, still selected by `JARVIS_HARNESS` so every
 * existing suite keeps working unchanged. `fake:<variant>` maps to the fake
 * runtime; anything else names a runtime directly.
 */
const DEFAULT_RUNTIME_ID = FAKE_HARNESS ? "fake" : HARNESS_SPEC;

type Task = {
  id: string;
  title: string;
  objective: string | null;
  project_id: string | null;
  auth_profile_id: string | null;
  conversation_id: string | null;
  /** S28: which engine this task asked for. Null means the project's default. */
  runtime: string | null;
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
  /** S28: what this project's work runs on unless a task says otherwise. */
  default_runtime: string | null;
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
): Promise<{ id: string; dir: string; harness: string | null } | { error: string }> {
  const wanted = task.auth_profile_id;
  if (wanted) {
    /*
     * S28: the harness comes from the route this profile is registered under,
     * not from a guess. An auth directory and a CLI are a matched pair - handing
     * codex the anthropic login is not a degraded run, it is an unauthenticated
     * one that reports 401 and looks like an expired subscription.
     */
    const r = await pool.query<{ id: string; dir: string | null; harness: string | null }>(
      `SELECT a.id, a.harness_auth_dir AS dir,
              (SELECT m.harness FROM model_registry m
               WHERE m.auth_profile_id = a.id AND 'senior_engineer' = ANY (m.role_assignments)
               ORDER BY m.route_order LIMIT 1) AS harness
       FROM auth_profiles a
       WHERE a.auth_type = 'subscription_login' AND a.id = $1`,
      [wanted],
    );
    const row = r.rows[0];
    if (!row) return { error: `auth profile ${wanted} does not exist` };
    if (!row.dir) return { error: `auth profile ${row.id} has no completed host login` };
    return { id: row.id, dir: row.dir, harness: row.harness };
  }

  /*
   * Nobody chose, so the ladder chooses (S25).
   *
   * This used to be `id = 'anthropic_personal'` — one engine, hardcoded, and a
   * park the moment it was rate-limited. Two other subscriptions and a hosted
   * open-weights route were registered the whole time and never consulted:
   * "a task that stops because one of three available engines was busy is a
   * task that did not need to stop."
   */
  /*
   * S28: if the task named an engine, only that engine's routes are candidates.
   * The runtime id and the registry harness are different vocabularies, so the
   * translation is explicit rather than a string that happens to match.
   */
  const wantHarness = task.runtime
    ? Object.entries(HARNESS_TO_RUNTIME).find(([, id]) => id === task.runtime)?.[0] ?? task.runtime
    : null;
  const ladder = await engineerLadder(pool, {
    projectId: task.project_id, taskId: task.id, wantHarness,
  });
  if (!ladder.ok) return { error: ladder.reason };
  for (const note of ladder.skipped) console.log(`engineer ladder skipped ${note}`);
  if (!ladder.rung.authDir) {
    return { error: `${ladder.rung.profileId} has no completed host login` };
  }
  console.log(`engineer ladder chose ${ladder.rung.profileId} (${ladder.rung.kind}, ${ladder.rung.harness})`);
  return { id: ladder.rung.profileId, dir: ladder.rung.authDir, harness: ladder.rung.harness };
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
  /*
   * 0750, like its parent. It was being created with the default mask, so a
   * worktree came out drwxr-xr-x under a drwxr-x--- parent — world-readable in
   * principle, and inconsistent with every other directory in the tree.
   */
  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o750 });
  await fs.chmod(path.dirname(dir), 0o750).catch(() => undefined);

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
  /*
   * Cut from the freshest ref, and never silently from a stale one.
   *
   * This fetched with `.catch(() => undefined)` and then cut the worktree from
   * `origin/<base>` regardless. When the fetch failed the run got a worktree
   * from whatever `origin/<base>` last pointed at - and on the S28 parity run
   * that was the repository's initial commit. Codex opened a checkout holding
   * only README.md, correctly reported the bug was "not reproducible", and
   * looked like the weaker engine. It was reading a different repository state.
   *
   * So the fetch failing is recorded rather than swallowed, and the base is
   * chosen from what actually exists: the remote ref when it is current, the
   * local branch when the fetch could not update it.
   */
  /*
   * With the project's own deploy key, which it never had.
   *
   * This helper spawns git with no environment of its own, so the fetch went
   * out as whatever identity the jarvis user happens to have - which is none.
   * Against a private repository that can only fail, and it did, on every
   * heavy run since the check was added: "fetch of origin/main failed" was in
   * the log of every single task and read as background noise because the
   * fallback quietly worked.
   *
   * It worked for the benchmark because the benchmark force-pushes its seed and
   * then resets the local checkout to match, so local and remote agree. On a
   * real project they do not: anything pushed to GitHub since the last clone is
   * invisible, and the run silently engineers against stale code. That is the
   * failure the fallback was written to prevent, arriving through the door it
   * left open.
   */
  let fetchEnv: NodeJS.ProcessEnv | undefined;
  if (project) {
    const { loadProject, materialiseDeployKey, gitEnv } = await import("./checkout.js");
    const full = await loadProject(pool, project.id);
    const mat = full ? await materialiseDeployKey(pool, full) : { error: `project ${project.slug} not found` };
    if ("sshCommand" in mat) fetchEnv = gitEnv(mat.sshCommand);
    else console.error(`worktree base: fetching without a key (${mat.error})`);
  }
  const fetched = await git(repo, ["fetch", "--quiet", "origin", base], fetchEnv)
    .then(() => true)
    .catch(() => false);
  if (!fetched) console.error(`worktree base: fetch of origin/${base} failed; using the local ${base}`);
  const remote = await git(repo, ["rev-parse", "--verify", `origin/${base}`])
    .then((r) => r.trim())
    .catch(() => "");
  const local = await git(repo, ["rev-parse", "--verify", base])
    .then((r) => r.trim())
    .catch(() => "");
  /*
   * When both exist and differ, the one that CONTAINS the other is newer. A
   * merge-base check answers that without guessing at timestamps.
   */
  let from = remote || local || base;
  if (remote && local && remote !== local) {
    const remoteHasLocal = await git(repo, ["merge-base", "--is-ancestor", local, remote])
      .then(() => true)
      .catch(() => false);
    from = remoteHasLocal ? remote : local;
    if (from === local) {
      console.error(`worktree base: origin/${base} is behind the local ${base}; using the local one`);
    }
  }
  await git(repo, ["worktree", "add", "-b", branch, dir, from]);
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

/**
 * `env` is optional and matters for exactly one call: the fetch.
 *
 * Everything else here is local plumbing - prune, rev-parse, worktree add -
 * which never touches the network and needs no credential.
 */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
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
  /*
   * The run's home goes with its worktree, always.
   *
   * It holds a copy of the project's deploy key, so leaving it behind would
   * turn a per-run credential into a permanent one sitting next to every other
   * run's. Removed here rather than only on the isolation path, because every
   * run ends through this function and only some end through that one.
   */
  await fs.rm(`${dir}.home`, { recursive: true, force: true }).catch(() => undefined);
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

/**
 * What a run may touch besides its own worktree.
 *
 * Its own project, or — with no project — its own corner of `unscoped`. A task
 * with no project had NOTHING allowed but its cwd, so the ordinary business of a
 * git worktree referencing its parent read as a cross-boundary access and raised
 * a CRITICAL against `worktrees/unscoped`. Unscoped is a real boundary now: the
 * task's own directory under it, and nothing else in it.
 *
 * Exported so the wiring is testable, not only the checker: the first version of
 * this lived inline at the call site, where a test could assert what
 * `escapedPath` does with a list and nothing at all about the list it is given.
 */
/**
 * Turn a ladder refusal into a ticket that names the right remedy.
 *
 * Every failure to find an engine raised the same ticket: "[harness] no usable
 * subscription login for the heavy lane", with the required action "Complete
 * the Claude Code host login on the VPS". One of those sat in
 * `waiting_for_user` while the actual reason, sitting in its own evidence
 * field, was `anthropic_personal is not allowlisted for this project` - an
 * allowlist row, nothing to do with a login, and the login in question was
 * already done. A ticket that names the wrong remedy costs more than no ticket:
 * it sends Enrique to redo something that already works.
 *
 * The reasons are matched on the strings the ladder actually produces, listed
 * here so the next one can be added by reading this rather than by guessing.
 */
export function harnessIssueFor(reason: string): {
  category: string;
  title: string;
  dedupeKey: string;
  requiredAction: string;
} {
  if (/not allowlisted/i.test(reason)) {
    return {
      category: "config.invalid",
      title: "[harness] no engine is allowlisted for this project",
      dedupeKey: "harness.allowlist",
      requiredAction:
        "Allowlist an engineering profile for this project. The logins are fine - this is the "
        + "per-project allowlist, which fails closed by design (S12b), so a new project has no "
        + "engine until one is granted.",
    };
  }
  if (/no completed host login/i.test(reason)) {
    return {
      category: "provider.cred_expired",
      title: "[harness] no usable subscription login for the heavy lane",
      dedupeKey: "setup.harness.login",
      requiredAction: "Complete the Claude Code host login on the VPS as the jarvis user (ADR 006).",
    };
  }
  if (/does not exist/i.test(reason)) {
    return {
      category: "config.invalid",
      title: "[harness] this task asks for an auth profile that does not exist",
      dedupeKey: "harness.profile.missing",
      requiredAction:
        "The task names an auth profile Jarvis has no record of. Fix the task, or add the profile "
        + "on the Connections page.",
    };
  }
  /*
   * Anything else keeps the reason itself as the action. Inventing a remedy for
   * a failure mode nobody has seen is how the misleading ticket above was born.
   */
  return {
    category: "provider.cred_expired",
    title: "[harness] no engine could take this task",
    dedupeKey: "harness.no-route",
    requiredAction: `The engineering ladder refused every route. It said: ${reason}`,
  };
}

export function allowedPathsFor(
  slug: string | null,
  taskId: string,
  /**
   * The harness auth directory this run was actually given.
   *
   * The runner hands the vendor CLI its own config dir - CLAUDE_CONFIG_DIR for
   * Claude, CODEX_HOME for Codex - and the CLI then reads it. That read was
   * outside every allowed path, so the tripwire killed a run that had done 22
   * tool calls of honest work and reported `harness reached outside its
   * worktree: /var/lib/jarvis/harness-auth`. Telling a process where its
   * credentials live and then killing it for looking is not containment, it is
   * a bug.
   *
   * Scoped to the ONE profile directory, never to `harness-auth` itself: the
   * parent holds every other profile's tokens, and a run that can read those
   * has stepped around the broker entirely.
   */
  authDir?: string | null,
  /** The run's own HOME, when it has one: it holds this project's deploy key. */
  runHome?: string | null,
): string[] {
  /*
   * What a task may touch under the root, as a LIST rather than as prose
   * (II.5). Its own worktree is `cwd` and is added by the guard itself; these
   * are the two other places its own work legitimately lives:
   *
   *   projects/<its own>   the checkout its worktree was cut from
   *   artifacts/<its own>  its own transcripts and outputs
   *
   * Everything else under `/var/lib/jarvis` — another project's checkout,
   * another task's worktree, `browsers/`, `harness-auth/`, `keys/`,
   * `openclaw/`, another project's `artifacts/` — is denied by the default,
   * so adding a directory does not mean remembering to add it here.
   */
  /*
   * The ssh known_hosts the runner itself installed.
   *
   * `git push` reads it, and the tripwire killed a run for that after 23 tool
   * calls - having first watched the same run push its branch to GitHub
   * successfully. The directory holds exactly one file, `known_hosts`, which is
   * a list of public host fingerprints shared by every project: not a
   * credential, and not another project's anything. The suite asserts that it
   * stays that way, so this allowance cannot quietly become a key leak.
   */
  const sshHome = path.join(JARVIS_ROOT, "home", ".ssh");
  const own = [sshHome, ...(authDir ? [authDir] : []), ...(runHome ? [runHome] : [])];
  if (!slug) return [path.join(WORKTREES, "unscoped", taskId.slice(0, 8)), ...own];
  return [path.join(PROJECTS, slug), path.join(ARTIFACTS, slug), ...own];
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
  /*
   * The scratch directory is not outside.
   *
   * `jarvis-runner.service` sets `PrivateTmp=true`, so /tmp is the service's
   * own namespace — nothing else on the box can see it, and nothing in it
   * survives. A harness writing `/tmp/repro.mjs` to reproduce a bug is doing
   * exactly what it should, and that was being filed as a CRITICAL isolation
   * breach. A tripwire that fires on ordinary work is worse than none.
   */
  const permitted = [cwd, ...alsoAllowed, os.tmpdir(), "/tmp"].filter(Boolean);
  const inside = (abs: string) => {
    /*
     * The root itself is not a secret. `/var/lib/jarvis` — the bare directory,
     * not anything in it — was filed as a critical isolation breach, and all it
     * reveals is the names of the directories underneath, every one of which is
     * separately guarded below. An exact match only: `/var/lib/jarvis/keys` is
     * still very much outside.
     */
    if (abs === ROOT) return true;
    return permitted.some((root) => {
      const rel = path.relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
  };
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
        /*
         * Everything under the root is guarded, not a list of five things.
         *
         * The list WAS five prefixes, and II.5 enumerates seven — `openclaw/`
         * (the paired WhatsApp session) and another project's `artifacts/`
         * (transcripts, dumped documents) were both missing, exactly as the
         * plan warned: "the failure was an unlisted directory, not a broken
         * rule". So the rule is inverted. Anything under `/var/lib/jarvis`
         * that is not positively permitted is a breach, which means a
         * directory added tomorrow is protected the day it is created rather
         * than the day someone remembers to add it here.
         *
         * Outside the root is left alone deliberately: `/usr/lib`, a package
         * cache, a system binary are ordinary build traffic, and a guard that
         * fires on those is a guard that gets switched off.
         */
        if (abs.startsWith(`${ROOT}${path.sep}`)) return abs;
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
  /**
   * How the harness is to speak to the project's git remote.
   *
   * Without this the harness can do the whole job and not deliver it. Codex did
   * exactly that on the S28 parity run: it reproduced the bug, fixed it,
   * red-green verified the regression, ran the tests, made one focused commit -
   * and then reported "Push is blocked because the environment lacks a usable
   * GitHub SSH key". `gitEnv` existed and was used for the runner's own clone;
   * it was simply never handed to the process that had to push.
   *
   * The key is the project's own deploy key, so this grants exactly the access
   * the task needs and none beyond it.
   */
  gitSshCommand?: string | null;
  /** A HOME of this run's own, so the deploy key is the default ssh identity. */
  home?: string | null;
  transcriptPath: string;
  /** S28: which engine, and therefore how to start it and how to read it. */
  runtime: AgentRuntime;
  /**
   * The raw line is still passed, because the path tripwire reads vendor
   * structure directly and must not be limited to what normalisation chose to
   * keep. The normalised events are what everything else uses.
   */
  onEvent: (event: Record<string, unknown>, normalised: RuntimeEvent[]) => void;
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

  /*
   * S28. What to spawn and how to read it is the runtime's business; everything
   * below this line — the privilege drop, the network namespace, the scrubber,
   * the path tripwire — is Jarvis's containment and applies to all of them.
   */
  const spec = args.runtime.spawnSpec({
    prompt: args.prompt,
    authDir: args.configDir,
    cwd: args.cwd,
  });
  const command = spec.command;
  const commandArgs = spec.args;

  /*
   * Drop to the project's own unix user (ADR 016).
   *
   * This is the wall behind the file tripwire. Everything else in this runner
   * DETECTS a cross-project read; this is what makes the read fail. `sudo`
   * elevates for exactly as long as `setpriv` takes to drop, and the sudoers
   * rule permits nothing else and can never name root.
   */
  const dropped = args.asUser
    ? asProjectUser(args.asUser, command, commandArgs)
    : { command, args: commandArgs };
  if (args.asUser) console.log(`harness runs as ${args.asUser}`);

  /*
   * And its own network namespace (II.5, S12b item 5).
   *
   * The privilege drop stops it reading Jarvis's files; this stops it reaching
   * Jarvis's ports. Both are needed and neither substitutes for the other — a
   * harness with a shell and a route to 127.0.0.1:5432 has stepped around every
   * control in Part IV without needing a bug.
   */
  const egress = await planEgress();
  const spawned = egress.isolated
    ? { command: egress.command, args: [...egress.args, ...egressArgv(dropped.command, dropped.args)] }
    : dropped;
  if (!egress.isolated) {
    console.error(`harness egress NOT isolated: ${egress.reason}`);
  }

  const child = spawn(spawned.command, spawned.args, {
    cwd: args.cwd,
    env: {
      ...process.env,
      // The config-dir variable is the runtime's — codex reads CODEX_HOME and
      // ignores CLAUDE_CONFIG_DIR entirely, which presents as a 401.
      ...spec.env,
      JARVIS_FAKE_VARIANT: FAKE_VARIANT ?? "",
      ...(args.gitSshCommand
        ? { GIT_SSH_COMMAND: args.gitSshCommand, GIT_TERMINAL_PROMPT: "0" }
        : {}),
      ...(args.home ? { HOME: args.home } : {}),
      // Never let the harness inherit Jarvis's own database handle.
      DATABASE_URL: "",
      POSTGRES_PASSWORD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  /*
   * Bring the namespace up now that there is a pid to attach to, then release
   * the harness. If this throws the run still proceeds — with no network at all
   * rather than with the containment silently missing, which is the safe
   * direction — and the error is on the transcript.
   */
  if (egress.isolated && child.pid) {
    await egress.ready(child.pid).catch((err) => {
      console.error("egress namespace failed to come up:", err instanceof Error ? err.message : err);
    });
  }

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
    /*
     * The transcript is one of the four exits the scrubber has to cover (Part
     * V). It is written straight to disk rather than through the pool, so it is
     * the one place that needs the filter applied by hand — a harness that
     * echoes a key it was handed would otherwise leave it on the volume.
     */
    sink.write(scrubString(chunk.toString("utf8")));
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
      /*
       * S28: the outcome is read through the runtime, so a codex `turn.failed`
       * and a claude `result` with `is_error` arrive here as the same thing.
       * The empty-string trap is handled inside the runtime now — a failing
       * claude result carries `result: ""`, which normalises to a null summary
       * so the fallback chain below can reach the subtype.
       */
      const normalised = args.runtime.normalise(event);
      for (const ev of normalised) {
        if (ev.kind === "session") seen.sessionId = ev.sessionId;
        if (ev.kind === "result") {
          seen.result = ev.summary;
          seen.subtype = ev.subtype;
          seen.isError = !ev.ok;
        }
      }
      if (!escape) {
        const out = escapedPath(args.cwd, event, args.allowedPaths ?? []);
        if (out) {
          escape = out;
          child.kill("SIGKILL");
        }
      }
      args.onEvent(event, normalised);
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
  // The namespace dies with its process; slirp does not, and a slirp per run
  // that nobody stops is a process leak with a name.
  if (egress.isolated) egress.cleanup();
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

/**
 * Exported for the S28 suite, which points a task at a runtime that is not
 * there and asserts it parks. Driving the queue instead would test the queue.
 */
export async function runHeavyTask(pool: pg.Pool, taskId: string): Promise<void> {
  const t = await pool.query<Task>(
    `SELECT id, title, objective, project_id, auth_profile_id, conversation_id, runtime
     FROM tasks WHERE id = $1`,
    [taskId],
  );
  const task = t.rows[0];
  if (!task) return;

  const p = task.project_id
    ? await pool.query<Project>(
        `SELECT id, slug, name, project_type, confidentiality, github_owner, github_repo,
                default_branch, default_runtime
         FROM projects WHERE id = $1`,
        [task.project_id],
      )
    : null;
  const project = p?.rows[0] ?? null;

  /*
   * S28: a runtime nobody recognises is a typo, and it is checked here - before
   * the engineering ladder is consulted at all.
   *
   * It used to be checked after the ladder had chosen a credential. Once the
   * task's runtime began FILTERING the ladder, an unknown id stopped matching
   * any route and came back as "no engineering route is registered for
   * codex-that-is-not-here" - true, and much less useful than naming the
   * runtimes that exist. The order of two checks decided the quality of the
   * message.
   */
  /*
   * The heavy lane needs a repository. No project, no run.
   *
   * A task with no project was given "its own corner of unscoped" - an empty
   * directory that is not a git checkout - and the harness was started in it
   * anyway. What happened next, on a real call: the task was the sentence
   * "Hello, can you finish what you were saying?", conversational filler that
   * became work. Claude landed in an empty directory, correctly reported there
   * was nothing to continue from, and while looking around ran
   * `ls -la /var/lib/jarvis/worktrees/unscoped/`. Listing its own parent is
   * outside the paths the run is allowed to touch, so the isolation tripwire
   * killed the run and raised a CRITICAL - for a directory listing, in a
   * directory that was empty, on a task that should never have existed.
   *
   * Parking here rather than tightening the tripwire, because the tripwire was
   * right: a run whose boundary is an empty scratch directory has no meaningful
   * boundary at all. Five of the thirty heavy tasks on the box had no project;
   * none of the 721 system tasks did. Unscoped heavy work is an accident every
   * time, so it fails closed and says which sentence caused it.
   */
  if (!task.project_id) {
    await park(pool, taskId, "waiting_for_user",
      "a heavy task has no project, so it has no repository to work in",
      {
        category: "config.invalid",
        title: "[runner] a heavy task arrived with no project",
        dedupeKey: "runner.heavy.unscoped",
        requiredAction:
          `The task "${(task.title ?? "").slice(0, 80)}" was queued to the heavy lane with no `
          + "project, so there is nothing to check out and nothing for the harness to read. "
          + "Scope it to a project or cancel it; do not run it unscoped.",
      },
      null);
    return;
  }

  const askedRuntime = task.runtime ?? project?.default_runtime ?? null;
  if (askedRuntime && !runtimeFor(askedRuntime)) {
    await park(pool, taskId, "waiting_for_user",
      `no runtime called ${askedRuntime}`,
      {
        category: "config.invalid",
        title: `[runtime] ${askedRuntime} is not a runtime Jarvis knows`,
        dedupeKey: `runtime.unknown.${askedRuntime}`,
        requiredAction:
          `This task asks to run on "${askedRuntime}", which is not a runtime. Known: `
          + `${Object.keys(RUNTIMES).join(", ")}. Fix the task or the project default.`,
      },
      task.project_id);
    return;
  }

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
    await park(pool, taskId, "waiting_for_provider", profile.error,
      harnessIssueFor(profile.error), task.project_id);
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
    /*
     * What the project already knows (S30).
     *
     * "so a coding task can consult what Enrique said about the project three
     * weeks ago" - the same retrieval the console uses, so the two cannot drift
     * into different ideas of what the project knows.
     *
     * Appended only when there is something to say. A project with no memories
     * gets a byte-identical prompt to before, which is deliberate: the
     * benchmark corpus has no memories, so its runs stay comparable with the
     * ones recorded before this existed.
     */
    const { contextForTask } = await import("./knowledge.js");
    const known = await contextForTask(pool, {
      projectId: task.project_id,
      title: task.title,
      objective: task.objective ?? task.title,
    }).catch(() => null);

    const objective = workflowPrompt({
      title: task.title,
      objective: `${(task.objective ?? task.title).trim()}${known ?? ""}`,
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
    let errorsRecorded = 0;
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

    /*
     * S28: which engine runs this.
     *
     * The task's own choice wins, then the project's default, then the host's.
     * An id nobody recognises is refused rather than quietly replaced — the
     * whole point of naming a runtime is that the answer to "which engine
     * produced this?" is not a guess.
     */
    /*
     * The engine follows the CREDENTIAL, not a separate field.
     *
     * This was wrong when first written: it resolved the runtime from
     * `task.runtime` alone, which meant a task pinned to codex could be handed
     * anthropic's auth directory by the ladder and run `codex` against it. That
     * does not fail loudly — codex finds no login and reports 401, which reads
     * exactly like an expired subscription. An auth directory and a CLI are a
     * matched pair.
     *
     * So the rung the ladder chose names the harness, and the harness names the
     * runtime. `task.runtime` and the project default are a CONSTRAINT: if they
     * disagree with the profile that was actually available, the task parks
     * rather than running on an engine nobody asked for.
     */
    const wantedRuntime = task.runtime ?? project?.default_runtime ?? null;

    /*
     * A name nobody recognises is a typo in every mode, so this is checked
     * before the fake-harness short-circuit rather than after it. The first
     * version of this had the order the other way round, which meant that under
     * the fake harness — the mode every offline suite runs in — a task could ask
     * for "codex-that-is-not-here" and quietly run on the fake. The selection
     * logic was unreachable by exactly the tests written to exercise it.
     */
    const fromProfile = runtimeForHarness(profile.harness);
    const runtime = FAKE_HARNESS
      ? RUNTIMES.fake
      : (fromProfile ?? runtimeFor(wantedRuntime ?? DEFAULT_RUNTIME_ID));

    if (runtime && wantedRuntime && !FAKE_HARNESS && runtime.id !== wantedRuntime) {
      await park(pool, task.id, "waiting_for_user",
        `asked for ${wantedRuntime} but the usable credential is ${profile.id} (${runtime.id})`,
        {
          category: "config.invalid",
          title: `[runtime] ${wantedRuntime} was asked for and ${runtime.id} is what is available`,
          dedupeKey: `runtime.mismatch.${task.id}`,
          requiredAction:
            `This task asks to run on ${wantedRuntime}, but the engineering ladder could only `
            + `offer ${profile.id}, which is driven by ${runtime.id}. Jarvis will not run one `
            + "vendor's CLI against another vendor's login. Allowlist the right profile for this "
            + `project, or change the task's runtime to ${runtime.id}.`,
        },
        task.project_id);
      return;
    }
    if (!runtime) {
      await park(pool, task.id, "waiting_for_user",
        `no runtime for ${wantedRuntime ?? profile.harness ?? "this profile"}`,
        {
          category: "config.invalid",
          title: `[runtime] ${wantedRuntime ?? profile.harness} is not a runtime Jarvis knows`,
          dedupeKey: `runtime.unknown.${wantedRuntime ?? profile.harness ?? "none"}`,
          requiredAction:
            `This task resolves to "${wantedRuntime ?? profile.harness}", which is not a runtime. Known: `
            + `${Object.keys(RUNTIMES).join(", ")}. Set the task's or the project's runtime to one of those.`,
        },
        task.project_id);
      return;
    }
    /*
     * "Point a task at a runtime that is not installed → a clean
     * `provider.cred_expired`-class park with a useful message, not a crash."
     * Checked before the worktree is touched, so a missing binary costs nothing
     * and the task can be requeued the moment it is installed.
     */
    const availability = await runtimeAvailable(runtime);
    if (!availability.available) {
      await park(pool, task.id, "waiting_for_user",
        `${runtime.displayName}: ${availability.detail}`,
        {
          category: "provider.cred_expired",
          title: `[runtime] ${runtime.displayName} is not installed on this host`,
          dedupeKey: `runtime.missing.${runtime.id}`,
          requiredAction:
            `This task is pointed at ${runtime.displayName} and ${availability.detail}. `
            + "Install it on the box, or point the task at a runtime that is there. "
            + "Nothing was run and the task can be requeued as soon as it exists.",
        },
        task.project_id);
      return;
    }
    await pool.query("UPDATE tasks SET ran_on_runtime = $2 WHERE id = $1", [task.id, runtime.id]);

    /*
     * The deploy key, materialised for the harness as well as for the clone.
     * A project with no repository simply has none, and the harness then has
     * nothing to push to - which is the honest state, not an error.
     */
    /*
     * A HOME of this run's own, holding this project's deploy key as the
     * DEFAULT ssh identity.
     *
     * `GIT_SSH_COMMAND` alone is not enough, and the parity run is what proved
     * it: Codex pushes with `GIT_SSH_COMMAND='ssh -F /dev/null' git push`,
     * overriding whatever Jarvis set and discarding every configured identity
     * with it. `-F /dev/null` still falls back to the default key names, so a
     * key at `$HOME/.ssh/id_ed25519` survives exactly the thing that defeated
     * the variable. Claude, which uses what it is given, is unaffected either
     * way.
     *
     * Per RUN rather than shared: the home sits beside the worktree and holds
     * one project's key, so it cannot become a place where every project's
     * credentials pile up. Isolation here is the point, not a side effect.
     */
    const runHome = `${workspace.dir}.home`;
    const gitSshCommand = project
      ? await (async () => {
          // Imported here, like the checkout above, so a run with no repository
          // does not pay for the module at all.
          const { loadProject, materialiseDeployKey } = await import("./checkout.js");
          const repo = await loadProject(pool, project.id).catch(() => null);
          if (!repo) return null;
          const key = await materialiseDeployKey(pool, repo).catch(() => null);
          // A project whose key cannot be materialised gets no push access and
          // says so through the harness, rather than failing the run here.
          if (!key || !("sshCommand" in key)) return null;

          /*
           * Every step says so when it fails.
           *
           * These were `.catch(() => undefined)` - the same silent swallow that
           * hid a stale worktree base earlier - and when a run then could not
           * push, there was nothing to read: the key was either never copied or
           * copied somewhere else, and the log could not say which. A setup step
           * that fails quietly turns into an agent reporting "SSH key access is
           * unavailable" twenty minutes later.
           */
          const ssh = path.join(runHome, ".ssh");
          const keyAt = path.join(ssh, "id_ed25519");
          const say = (what: string) => (err: unknown) =>
            console.error(`run home: ${what} failed: ${err instanceof Error ? err.message : err}`);
          await fs.mkdir(ssh, { recursive: true, mode: 0o700 }).catch(say("mkdir"));
          // 0600 from the start: ssh refuses a key any wider, and a chmod after
          // the write leaves a window where it is readable.
          await fs.copyFile(key.keyFile, keyAt).catch(say(`copy ${key.keyFile}`));
          await fs.chmod(keyAt, 0o600).catch(say("chmod"));
          await fs.copyFile(
            path.join(JARVIS_ROOT, "home", ".ssh", "known_hosts"),
            path.join(ssh, "known_hosts"),
          ).catch(say("copy known_hosts"));
          const placed = await fs.stat(keyAt).then((st) => st.size > 0).catch(() => false);
          console.log(`run home ${runHome}: key ${placed ? "in place" : "MISSING"}`);
          return key.sshCommand;
        })()
      : null;

    const outcome = await runHarness({
      cwd: workspace.dir,
      configDir: profile.dir,
      prompt: objective,
      runtime,
      transcriptPath: path.join(ARTIFACTS, relTranscript),
      signal: controller.signal,
      allowedPaths: allowedPathsFor(project?.slug ?? null, task.id, profile.dir, runHome),
      gitSshCommand,
      home: gitSshCommand ? runHome : null,
      asUser,
      onEvent: (event, normalised) => {
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
        /*
         * Failures, kept rather than dropped.
         *
         * Both runtimes already normalise `{ kind: "error" }` and the runner
         * threw them away, so `task_events` recorded a run's successes and
         * nothing else: a clean run and one that failed half its commands were
         * indistinguishable afterwards. S29's `tool_reliability` could not be
         * scored at all - and a dimension every run passes measures nothing.
         *
         * Capped with the same budget as tool calls: a harness stuck in a retry
         * loop must not be able to fill the table with its own noise.
         */
        for (const failure of normalised.filter((e) => e.kind === "error")) {
          if (errorsRecorded >= MAX_TOOL_EVENTS) break;
          errorsRecorded += 1;
          void pool
            .query(
              `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1, 'error', $2, $3)`,
              [taskId, "harness_error", (failure as { message: string }).message.slice(0, 500)],
            )
            .catch(() => undefined);
        }

        for (const call of normalised.flatMap((e) => (e.kind === "tool" ? e.calls : []))) {
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

    /*
     * It ran, so it has quota (S25).
     *
     * This is the only reading of any of the three subscriptions that is not an
     * inference — none of them exposes a usage API. A run that finished is
     * direct evidence the engine was available, and it clears an `exhausted`
     * mark left by an earlier estimate that turned out to be pessimistic.
     */
    if (outcome.code === 0 && !stopReason && !outcome.escape) {
      await noteServed(pool, { profileId: profile.id, taskId }).catch(() => undefined);
    }

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
        // The run's home holds a copy of the project deploy key, so it goes
        // when the worktree does rather than lingering on disk.
        await fs.rm(runHome, { recursive: true, force: true }).catch(() => undefined);
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
        /*
         * "touched", not "wrote".
         *
         * The tripwire reads tool events, and a Bash command is a string: it
         * cannot always tell a read from a write. The one that fired in anger
         * was `ls -la` on the worktree parent, and the ticket announced that the
         * harness had WRITTEN outside its worktree - which sent the next reader
         * looking for a file that was never created. Both still matter, so both
         * still fire; the title now claims only what is known, and
         * `attempted_path` in the evidence says where.
         */
        title: `[isolation] harness touched a path outside the worktree on ${task.title.slice(0, 60)}`,
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

      /*
       * A spent engine is a routing fact, not a failure (S25).
       *
       * Before this, a subscription limit parked the task and paged Enrique,
       * with two other subscriptions and a hosted route sitting idle. Now the
       * profile is marked exhausted — with the provider's own reset time when
       * it gave one, and an honest estimate when it did not — and the task goes
       * straight back on the queue, where `resolveProfile` will pick the next
       * rung. Enrique hears nothing, because nothing has gone wrong.
       *
       * The retry budget is deliberately NOT consulted here. It counts attempts
       * against one engine; moving to a different engine is not a retry of the
       * same thing. What bounds the loop instead is the ladder itself: each
       * exhausted profile is skipped on the next pass, so there are at most as
       * many requeues as there are engines, and then it parks.
       */
      if (verdict.quota && !task.auth_profile_id) {
        await noteRateLimited(pool, {
          profileId: profile.id,
          resetsAt: retryAfterFrom(outcome.result),
          detail: summary.slice(0, 300),
          taskId,
        });
        const next = await engineerLadder(pool, { projectId: task.project_id, taskId });
        if (next.ok) {
          await pool.query(
            `UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_until = NULL,
               auth_profile_id = NULL, waiting_reason = $2, updated_at = now() WHERE id = $1`,
            [taskId, `${profile.id} is spent; moving to ${next.rung.profileId}`],
          );
          await pool.query(
            `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
             VALUES ($1, 'running', 'queued', $2, 'runner')`,
            [taskId, `engine ${profile.id} spent, next is ${next.rung.profileId}`],
          ).catch(() => undefined);
          console.log(`task ${taskId}: ${profile.id} spent, moving to ${next.rung.profileId}`);
          return;
        }
        // Nothing left. Park saying which engines are spent and when each returns.
        await pool.query(`UPDATE tasks SET waiting_reason = $2 WHERE id = $1`, [
          taskId,
          next.reason.slice(0, 500),
        ]).catch(() => undefined);
        await transitionTask(
          pool, taskId, "waiting_for_provider", next.reason.slice(0, 300), "runner", "lease_until = NULL",
        );
        await raiseIssue(pool, {
          category: "provider.cred_expired",
          service: "harness",
          owner: "user",
          status: "waiting_for_user",
          title: `[harness] every engine is spent`,
          dedupeKey: `quota.allspent:${taskId}`,
          taskId,
          projectId: task.project_id,
          requiredAction: next.reason,
          evidence: { skipped: next.skipped },
        });
        return;
      }

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
