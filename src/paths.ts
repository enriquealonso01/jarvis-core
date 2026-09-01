import path from "node:path";

/**
 * Every filesystem path Jarvis owns, derived from one root.
 *
 * `/var/lib/jarvis` was hardcoded in eleven places, which is why the engineering
 * loop could not be run anywhere except the VPS: a dev box had to reproduce a
 * root-owned host directory before a single task could execute. Plan S1 makes
 * `JARVIS_ROOT` authoritative so the same code runs in the dev compose stack,
 * in CI, and on Netcup with nothing changed but an env var.
 *
 * The default is deliberately the production path, so nothing on the box has to
 * set the variable to keep working.
 */
export const JARVIS_ROOT = process.env.JARVIS_ROOT ?? "/var/lib/jarvis";

export const ARTIFACTS_DIR = path.join(JARVIS_ROOT, "artifacts");
export const WORKTREES_DIR = path.join(JARVIS_ROOT, "worktrees");
export const PROJECTS_DIR = path.join(JARVIS_ROOT, "projects");
export const BROWSERS_DIR = path.join(JARVIS_ROOT, "browsers");
export const QUARANTINE_DIR = path.join(JARVIS_ROOT, "quarantine");
export const KEYS_DIR = path.join(JARVIS_ROOT, "keys");
export const HARNESS_AUTH_DIR = path.join(JARVIS_ROOT, "harness-auth");
