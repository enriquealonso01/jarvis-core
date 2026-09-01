/**
 * Reset the dev stack to a known state in one command (plan S1).
 *
 *   docker compose -f deploy/compose.dev.yaml run --rm seed
 *
 * Idempotent and destructive in the same breath: it wipes the work tables, so
 * every test starts from the same place and a failed run never contaminates the
 * next one. It refuses to touch anything unless JARVIS_DEV is set, because the
 * one thing worse than a slow test is a seed script pointed at Netcup.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import argon2 from "argon2";
import { createPool, migrate } from "../src/db.js";
import { HARNESS_AUTH_DIR, JARVIS_ROOT, PROJECTS_DIR } from "../src/paths.js";

if (process.env.JARVIS_DEV !== "1") {
  console.error("refusing to seed: JARVIS_DEV=1 is required (this wipes tasks, issues and audit rows)");
  process.exit(1);
}

const OPERATOR_EMAIL = process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local";
const OPERATOR_PASSWORD = process.env.JARVIS_DEV_PASSWORD ?? "dev-password-1234";
const PROJECT_SLUG = "dev-sandbox";
const ORIGINS = path.join(JARVIS_ROOT, "dev-origins");

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr?.trim() || r.status}`);
  }
  return (r.stdout ?? "").trim();
}

/**
 * A throwaway repo with a real `origin`.
 *
 * The runner does `git worktree add -b <branch> <dir> origin/<base>`, so a plain
 * `git init` checkout is not enough — there has to be a remote-tracking ref. A
 * local bare repo gives that with no network and no GitHub account.
 */
async function seedRepo(): Promise<string> {
  const bare = path.join(ORIGINS, `${PROJECT_SLUG}.git`);
  const work = path.join(PROJECTS_DIR, PROJECT_SLUG, "repo");
  await fs.rm(bare, { recursive: true, force: true });
  await fs.rm(path.join(PROJECTS_DIR, PROJECT_SLUG), { recursive: true, force: true });
  await fs.mkdir(bare, { recursive: true });
  await fs.mkdir(path.dirname(work), { recursive: true });

  git(bare, ["init", "--bare", "--initial-branch=main", "."]);
  git(ORIGINS, ["clone", "--quiet", bare, work]);
  git(work, ["config", "user.email", "dev@jarvis.local"]);
  git(work, ["config", "user.name", "Jarvis Dev Seed"]);
  await fs.writeFile(
    path.join(work, "README.md"),
    "# dev-sandbox\n\nA throwaway repo the fake harness commits into. Nothing here is real.\n",
  );
  await fs.writeFile(path.join(work, "app.js"), "export function login() {\n  return false; // the bug\n}\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "Initial commit"]);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["fetch", "-q", "origin", "main"]);
  return work;
}

async function main(): Promise<void> {
  const pool = createPool();
  await migrate(pool);

  // Work tables only. Migration 002's seeds (system projects, auth profiles,
  // schedules) are left alone — they are the fixture, not the test data.
  //
  // CASCADE reaches further than the list suggests: `conversations` has an FK to
  // `inbox_events` (created_from_inbox_id), so truncating the inbox silently
  // takes every thread with it, including the console thread migration 002
  // seeds. Recreate it below rather than pretending the list is exhaustive.
  await pool.query(`
    TRUNCATE task_checkpoints, task_transitions, task_attempts, task_grants, task_dependencies,
             issue_events, issues, notifications_outbox, audit_events, artifacts, messages,
             inbox_events, tasks, user_action_requests, approvals, memory_items
    RESTART IDENTITY CASCADE
  `);

  // Projects are fixture, not test data - but only the ones this script creates.
  // A test (or a sabotage) that creates a project left it behind, because the
  // truncate list above is all work tables, and the next run then had a project
  // in it that nobody had asked for. "Reset to a known state" has to mean the
  // projects too, or one test silently changes the world the next one runs in.
  await pool.query(
    `DELETE FROM projects
     WHERE is_system = false AND slug <> ALL($1::text[])`,
    [[PROJECT_SLUG, "alpha-web", "alpha-mobile"]],
  );

  // The console's own thread: unscoped, so nothing pre-selects a project for the
  // Supervisor. That is the case worth testing.
  const conversation = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel) VALUES (NULL, 'Supervisor', 'web')
     RETURNING id`,
  );

  for (const dir of ["artifacts", "worktrees", "projects", "browsers", "quarantine", "keys", "harness-auth", "dev-origins"]) {
    await fs.mkdir(path.join(JARVIS_ROOT, dir), { recursive: true });
  }

  const keyPath = process.env.MASTER_KEY_PATH ?? path.join(JARVIS_ROOT, "keys", "master.key");
  if (!(await fs.stat(keyPath).then(() => true, () => false))) {
    await fs.writeFile(keyPath, crypto.randomBytes(32), { mode: 0o400 });
  }

  // The operator. Deterministic password: this database is disposable and the
  // point of the step is that someone can log in without hunting for a file.
  const hash = await argon2.hash(OPERATOR_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [OPERATOR_EMAIL, hash],
  );

  const work = await seedRepo();

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality, github_owner, github_repo, default_branch)
     VALUES ($1, 'Dev Sandbox', 'personal', 'normal', 'jarvis-dev', $1, 'main')
     ON CONFLICT (slug) DO UPDATE SET default_branch = 'main', archived_at = NULL
     RETURNING id`,
    [PROJECT_SLUG],
  );

  // Two projects whose names share a prefix. Without them "ambiguous request
  // matching two projects" (S2) cannot be tested at all, and the resolver would
  // only ever be exercised on the easy path.
  await pool.query(
    `INSERT INTO projects (slug, name, project_type, confidentiality, default_branch)
     VALUES ('alpha-web', 'Alpha Web', 'personal', 'normal', 'main'),
            ('alpha-mobile', 'Alpha Mobile', 'personal', 'normal', 'main')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL`,
  );

  // The heavy lane refuses to run without a completed host login. In dev there
  // is no subscription to log into, so point the profile at an empty config dir:
  // the fake harness ignores it, and the check that a profile must be *chosen*
  // rather than substituted still runs for real.
  const authDir = path.join(HARNESS_AUTH_DIR, "anthropic_personal");
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await pool.query(
    `UPDATE auth_profiles SET harness_auth_dir = $1, health = 'healthy' WHERE id = 'anthropic_personal'`,
    [authDir],
  );

  console.log(
    [
      "seeded:",
      `  operator   ${OPERATOR_EMAIL} / ${OPERATOR_PASSWORD}`,
      `  project    ${PROJECT_SLUG} (${project.rows[0].id})`,
      "  projects   alpha-web, alpha-mobile (for the ambiguity test)",
      `  thread     ${conversation.rows[0].id} (unscoped, channel web)`,
      `  repo       ${work}`,
      `  harness    ${process.env.JARVIS_HARNESS ?? "claude"}`,
      `  root       ${JARVIS_ROOT}`,
    ].join("\n"),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
