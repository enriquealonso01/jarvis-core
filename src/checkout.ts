import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { PROJECTS_DIR } from "./paths.js";

const run = promisify(execFile);

/**
 * Project checkouts, each reachable only by its own key (plan S5).
 *
 * The rule this module exists to enforce is one line long: a project's repo is
 * cloned with a **project-scoped deploy key**, never with the personal admin
 * credential. Everything else here is in service of making that true even when
 * something goes wrong — the key is written 0600 under the project's own
 * directory, `IdentitiesOnly=yes` stops ssh from silently falling back to an
 * agent or to `~/.ssh/id_*`, and each project gets its own `known_hosts` so one
 * project cannot teach another to trust a host.
 *
 * The failure this design is aimed at is not "the clone did not work". It is
 * "the clone worked, using the wrong key, and nobody noticed".
 */

export type ProjectRepo = {
  id: string;
  slug: string;
  github_owner: string | null;
  github_repo: string | null;
  default_branch: string | null;
  deploy_key_credential_id: string | null;
};

export function projectDir(slug: string): string {
  return path.join(PROJECTS_DIR, slug);
}

export function repoDir(slug: string): string {
  return path.join(projectDir(slug), "repo");
}

function keyPath(slug: string): string {
  return path.join(projectDir(slug), ".ssh", "id_ed25519");
}

export async function loadProject(pool: pg.Pool, projectId: string): Promise<ProjectRepo | null> {
  const r = await pool.query<ProjectRepo>(
    `SELECT id, slug, github_owner, github_repo, default_branch, deploy_key_credential_id
     FROM projects WHERE id = $1`,
    [projectId],
  );
  return r.rows[0] ?? null;
}

/**
 * Write this project's deploy key to disk and return the ssh command that uses
 * it and nothing else.
 *
 * `IdentitiesOnly=yes` is the load-bearing option. Without it, ssh offers every
 * key it can find — the agent's, the invoking user's — and a clone that should
 * have failed for want of the right key succeeds with the wrong one. That is
 * the cross-project read the plan says stops all other work until it is closed,
 * and it would look exactly like success.
 */
export async function materialiseDeployKey(
  pool: pg.Pool,
  project: ProjectRepo,
): Promise<{ sshCommand: string; keyFile: string } | { error: string }> {
  if (!project.deploy_key_credential_id) {
    return { error: `project ${project.slug} has no deploy key` };
  }
  let payload: Record<string, string>;
  try {
    payload = await readJsonCredential(pool, project.deploy_key_credential_id);
  } catch (err) {
    return { error: `deploy key unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const priv = payload.private_key_openssh ?? payload.private_key;
  if (!priv) return { error: `deploy key for ${project.slug} has no private key` };

  const dir = path.dirname(keyPath(project.slug));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = keyPath(project.slug);
  // Written 0600 from the start rather than chmod-ed afterwards: ssh refuses a
  // key with loose permissions, and a moment of 0644 on a private key is still
  // a moment of 0644 on a private key.
  await fs.writeFile(file, priv.endsWith("\n") ? priv : `${priv}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);

  const known = path.join(dir, "known_hosts");
  const sshCommand = [
    "ssh",
    "-i",
    file,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${known}`,
    "-o",
    "BatchMode=yes",
  ].join(" ");
  return { sshCommand, keyFile: file };
}

/**
 * The environment a git command must run in to act as this project and only
 * this project.
 *
 * `GIT_TERMINAL_PROMPT=0` and `BatchMode=yes` together mean a missing or wrong
 * key is an immediate failure rather than a hang waiting for a passphrase — a
 * hung clone inside a task looks like a stuck harness and gets diagnosed as the
 * wrong thing entirely.
 */
export function gitEnv(sshCommand: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: sshCommand,
    GIT_TERMINAL_PROMPT: "0",
    // Never let a project's git operation pick up Jarvis's own database handle.
    DATABASE_URL: "",
    POSTGRES_PASSWORD: "",
  };
}

/**
 * The SSH URL for a project's remote.
 *
 * Templated rather than hardcoded to github.com, because a self-hosted git host
 * is a real deployment and because the isolation test needs a real SSH server it
 * can refuse connections on. `{owner}` and `{repo}` are substituted; the default
 * is GitHub and nothing in production sets the override.
 */
export function sshUrl(owner: string, repo: string): string {
  const template = process.env.JARVIS_GIT_URL_TEMPLATE ?? "git@github.com:{owner}/{repo}.git";
  return template.replace("{owner}", owner).replace("{repo}", repo);
}

async function git(
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await run("git", args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || "git failed").trim().slice(0, 500) };
  }
}

/**
 * Can this project reach this remote, with its own key?
 *
 * Exposed because it is the isolation assertion in L6: project A pointed at
 * project B's repo must FAIL. A test that only checks its own repo clones
 * proves nothing about whether the key is scoped.
 */
export async function lsRemote(
  pool: pg.Pool,
  projectId: string,
  owner: string,
  repo: string,
): Promise<{ ok: true; refs: string } | { ok: false; error: string }> {
  const project = await loadProject(pool, projectId);
  if (!project) return { ok: false, error: "no such project" };
  const key = await materialiseDeployKey(pool, project);
  if ("error" in key) return { ok: false, error: key.error };
  const r = await git(["ls-remote", sshUrl(owner, repo)], {
    env: gitEnv(key.sshCommand),
    timeoutMs: 45_000,
  });
  return r.ok ? { ok: true, refs: r.stdout } : { ok: false, error: r.error };
}

/**
 * Make sure the project's repo is on disk and current.
 *
 * Idempotent: clones when absent, fetches when present. Called from the runner
 * before a worktree is cut, which is the "first use" half of the plan's "wire
 * key provisioning to project create and to first use".
 */
export async function ensureProjectCheckout(
  pool: pg.Pool,
  projectId: string,
): Promise<{ ok: true; dir: string; cloned: boolean } | { ok: false; error: string }> {
  const project = await loadProject(pool, projectId);
  if (!project) return { ok: false, error: "no such project" };
  if (!project.github_owner || !project.github_repo) {
    return { ok: false, error: `project ${project.slug} has no linked repository` };
  }
  const key = await materialiseDeployKey(pool, project);
  if ("error" in key) return { ok: false, error: key.error };
  const env = gitEnv(key.sshCommand);
  const dir = repoDir(project.slug);
  const url = sshUrl(project.github_owner, project.github_repo);

  const already = await fs.stat(path.join(dir, ".git")).then(() => true, () => false);
  if (already) {
    const fetched = await git(["fetch", "--prune", "origin"], { cwd: dir, env });
    if (!fetched.ok) return { ok: false, error: fetched.error };
    await audit(pool, projectId, "project.checkout.fetch", `${project.github_owner}/${project.github_repo}`);
    return { ok: true, dir, cloned: false };
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });
  const cloned = await git(["clone", "--quiet", url, dir], { env, timeoutMs: 300_000 });
  if (!cloned.ok) return { ok: false, error: cloned.error };
  await audit(pool, projectId, "project.checkout.clone", `${project.github_owner}/${project.github_repo}`);
  return { ok: true, dir, cloned: true };
}

async function audit(pool: pg.Pool, projectId: string, action: string, target: string): Promise<void> {
  await pool
    .query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('runner', $1, $2, $3, $4)`,
      [action, target, projectId, JSON.stringify({ host: os.hostname() })],
    )
    .catch(() => undefined);
}
