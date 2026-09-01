import { createPool } from "./db.js";
import { claimTask, runSystemTask, transitionTask } from "./jobs.js";
import { backoffSeconds, raiseIssue } from "./notify.js";
import { cronMatches } from "./cron.js";
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR, HARNESS_AUTH_DIR, PROJECTS_DIR, WORKTREES_DIR } from "./paths.js";

const WORKER_ID = process.env.WORKER_ID ?? "system-1";
const ARTIFACTS = ARTIFACTS_DIR;
const WORKTREES = WORKTREES_DIR;

async function fireDueSchedules(pool: ReturnType<typeof createPool>) {
  const now = new Date();
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  const rows = await pool.query<{
    id: string;
    name: string;
    project_id: string;
    cron: string;
    timezone: string;
    paused: boolean;
    overlap: string;
  }>(`SELECT id, name, project_id, cron, timezone, paused, overlap FROM schedules WHERE paused = false`);
  for (const s of rows.rows) {
    if (!cronMatches(s.cron, minute, s.timezone || "America/New_York")) continue;
    const already = await pool.query(
      `SELECT 1 FROM schedule_runs WHERE schedule_id = $1 AND scheduled_for = $2`,
      [s.id, minute.toISOString()],
    );
    if ((already.rowCount ?? 0) > 0) continue;
    if (s.overlap === "skip") {
      const active = await pool.query(
        `SELECT 1 FROM tasks t JOIN schedule_runs r ON r.task_id = t.id
         WHERE r.schedule_id = $1 AND t.state IN ('queued','preparing','running','recovering') LIMIT 1`,
        [s.id],
      );
      if ((active.rowCount ?? 0) > 0) continue;
    }
    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, priority, lane)
       VALUES ($1, $2, $2, 'queued', 'background', 'system') RETURNING id`,
      [s.project_id, s.name],
    );
    await pool.query(
      `INSERT INTO schedule_runs (schedule_id, task_id, scheduled_for, started_at)
       VALUES ($1, $2, $3, now())`,
      [s.id, task.rows[0].id, minute.toISOString()],
    );
  }
}

/**
 * How long a missed heartbeat is tolerated before the task is considered lost.
 *
 * Env-overridable for the same reason the runner's timers are: at its real
 * value this is a ninety-second wait per assertion, so the recovery path — the
 * one thing standing between a killed runner and lost work — was never actually
 * exercised. The default is the production value.
 */
const STALL_SECONDS = (() => {
  const raw = Number(process.env.JARVIS_STALL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
})();

async function watchdog(pool: ReturnType<typeof createPool>) {
  const stale = await pool.query<{ id: string; lane: string }>(
    `SELECT id, lane FROM tasks
     WHERE state IN ('running','preparing')
       AND heartbeat_at IS NOT NULL
       AND heartbeat_at < now() - make_interval(secs => $1)`,
    [STALL_SECONDS],
  );
  for (const t of stale.rows) {
    const lane = t.lane;
    // STATE_MACHINES.md: stalled, then recovering, then back to the queue —
    // each step recorded so the Work view shows what the watchdog did.
    await transitionTask(pool, t.id, "stalled", `heartbeat missed for ${STALL_SECONDS}s`, "watchdog");
    // ERROR_TAXONOMY.md dedupes worker.crash by *lane*, not by task. Keying on
    // the task id meant every stall opened a ticket that nothing would ever
    // close — the same mistake the supervisor path had before tick 7.
    await raiseIssue(pool, {
      category: "worker.crash",
      service: "worker",
      title: "[watchdog] a task missed its heartbeat",
      dedupeKey: `worker.crash:${lane}`,
      taskId: t.id,
      evidence: { task_id: t.id, lane },
      requiredAction:
        "The task was requeued from its last checkpoint. No action is needed unless this keeps recurring.",
    });
    await transitionTask(pool, t.id, "recovering", "watchdog recovery", "watchdog");
    const cp = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM task_checkpoints WHERE task_id = $1 ORDER BY at DESC LIMIT 1`,
      [t.id],
    );
    await transitionTask(
      pool,
      t.id,
      "queued",
      cp.rows[0] ? "requeued from latest checkpoint" : "requeued with no checkpoint",
      "watchdog",
      "lease_until = NULL, lease_owner = NULL",
    );

    // The recovery worked, so the ticket has served its purpose. It stays in the
    // trail as resolved rather than sitting open forever.
    await pool.query(
      `UPDATE issues
       SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')`,
      [`worker.crash:${lane}`],
    );
  }
}

async function drainOutbox(pool: ReturnType<typeof createPool>) {
  // A notification that ran out of retries while its channel was unpaired is
  // terminal, so pairing WhatsApp later would leave exactly the blockers that
  // asked for the pairing undelivered on it forever. Nothing is lost — every one
  // also went out over the UI channel — but dual-channel delivery would quietly
  // become single-channel for everything queued before setup finished.
  //
  // Revive only for a channel that is configured *now*: an unpaired channel is
  // never woken, so this cannot turn into a retry loop against a dead transport.
  const revived = await pool.query(
    `UPDATE notifications_outbox
     SET state = 'pending', attempts = 0, next_attempt_at = now(),
         last_error = 'retrying: channel is configured now'
     WHERE state = 'failed'
       AND channel IN (SELECT DISTINCT channel FROM channel_allowlist)
     RETURNING id`,
  );
  if (revived.rowCount) {
    console.log(`outbox: revived ${revived.rowCount} notification(s) after a channel was configured`);
  }

  const rows = await pool.query<{ id: string; channel: string }>(
    `SELECT id, channel FROM notifications_outbox
     WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     ORDER BY created_at LIMIT 20`,
  );
  for (const n of rows.rows) {
    if (n.channel === "ui") {
      await pool.query(`UPDATE notifications_outbox SET state = 'sent', attempts = attempts + 1 WHERE id = $1`, [n.id]);
      continue;
    }
    // No transport is paired yet, so this is expected rather than broken. Back
    // off on the taxonomy curve instead of hammering a flat interval.
    const attempts = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM notifications_outbox WHERE id = $1`,
      [n.id],
    );
    const next = backoffSeconds((attempts.rows[0]?.attempts ?? 0) + 4);
    await pool.query(
      `UPDATE notifications_outbox
       SET attempts = attempts + 1, last_error = 'whatsapp/phone transport not paired',
           next_attempt_at = now() + ($2 || ' seconds')::interval,
           state = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END
       WHERE id = $1`,
      [n.id, String(next)],
    );
  }
}

async function audioRetention(pool: ReturnType<typeof createPool>) {
  const expired = await pool.query<{ id: string; path: string; project_id: string | null }>(
    `SELECT id, path, project_id FROM artifacts
     WHERE retention_class = 'raw_audio' AND permanent = false
       AND retain_until IS NOT NULL AND retain_until < now()`,
  );
  for (const a of expired.rows) {
    const full = path.join(ARTIFACTS, a.path);
    await fs.unlink(full).catch(() => undefined);
    await pool.query(`DELETE FROM artifacts WHERE id = $1`, [a.id]);
  }
  const breach = await pool.query(
    `SELECT 1 FROM artifacts
     WHERE retention_class = 'raw_audio' AND permanent = false
       AND created_at < now() - interval '10 days' LIMIT 1`,
  );
  if ((breach.rowCount ?? 0) > 0) {
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       SELECT 'critical', 'security.retention_breach', 'retention', 'open', 'jarvis',
              '[retention] raw audio older than 10 days', 'sec.retention'
       WHERE NOT EXISTS (
         SELECT 1 FROM issues WHERE dedupe_key = 'sec.retention' AND status NOT IN ('resolved','ignored')
       )`,
    );
  }
}

/**
 * Reap worktrees left behind by crashed harness runs (ADR 015 consequence).
 *
 * The runner removes its own worktree in a `finally`, but a killed process or a
 * lost box skips that. On a machine this size an accumulation of abandoned
 * checkouts is a disk-full incident waiting to happen, and disk-full takes
 * everything with it.
 *
 * Only directories whose task has reached a terminal state are touched, so a
 * long-running task is never robbed of the tree it is working in.
 */
async function reapWorktrees(pool: ReturnType<typeof createPool>) {
  const projects = await fs.readdir(WORKTREES).catch(() => [] as string[]);
  for (const slug of projects) {
    const dir = path.join(WORKTREES, slug);
    const runs = await fs.readdir(dir).catch(() => [] as string[]);
    for (const short of runs) {
      const full = path.join(dir, short);
      const st = await fs.stat(full).catch(() => null);
      if (!st?.isDirectory()) continue;
      if (Date.now() - st.mtimeMs < 24 * 60 * 60 * 1000) continue;
      // `short` is the first 8 characters of the task uuid the runner created it
      // from. A directory that matches no terminal task is left alone.
      const done = await pool.query(
        `SELECT 1 FROM tasks
         WHERE left(id::text, 8) = $1
           AND state IN ('succeeded', 'failed_terminal', 'cancelled')
         LIMIT 1`,
        [short],
      );
      if (!done.rowCount) continue;
      await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
      console.log(`reaped abandoned worktree ${slug}/${short}`);
    }
  }
}

async function ensureDirs() {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.mkdir(WORKTREES, { recursive: true });
  await fs.mkdir(PROJECTS_DIR, { recursive: true });

  // ADR 006: one host-login directory per auth profile, 0700, never shared
  // between profiles. The layout is created at boot so a harness login has
  // somewhere correct to land rather than the CLI choosing for itself.
  const HARNESS_AUTH = HARNESS_AUTH_DIR;
  await fs.mkdir(HARNESS_AUTH, { recursive: true, mode: 0o700 });
  for (const profile of ["anthropic_personal", "openai_codex_personal", "cursor_personal"]) {
    const dir = `${HARNESS_AUTH}/${profile}`;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
    // The host CLI logins run as `jarvis`, so the directories must belong to it
    // even though the container process is root.
    await fs.chown(dir, 1000, 988).catch(() => undefined);
  }
  await fs.chown(HARNESS_AUTH, 1000, 988).catch(() => undefined);
}

/**
 * Notice that a host CLI login has actually happened.
 *
 * `auth_profiles.harness_auth_dir` is what suppresses the `setup.login.<id>`
 * blocker and marks a profile usable for harness spawn — and nothing ever wrote
 * it. All three logins could be completed on the VPS and Jarvis would keep
 * paging about them forever, with the profile still unusable.
 *
 * Existence of the directory is not evidence: it is created at boot. The proof
 * is the credential file the CLI writes on success, so that is what is checked —
 * presence and non-emptiness only. The contents are never read.
 */
const HOST_LOGIN_PROOF: Record<string, string> = {
  anthropic_personal: ".credentials.json",
  openai_codex_personal: "auth.json",
  cursor_personal: ".config/cursor/auth.json",
};

async function detectHostLogins(pool: ReturnType<typeof createPool>) {
  for (const [profile, proof] of Object.entries(HOST_LOGIN_PROOF)) {
    const dir = path.join(HARNESS_AUTH_DIR, profile);
    let signedIn = false;
    try {
      const st = await fs.stat(`${dir}/${proof}`);
      signedIn = st.isFile() && st.size > 0;
    } catch {
      signedIn = false;
    }

    // Health is reconciled every pass, not only on transition: gating it on the
    // directory changing left the profile reading `unknown` after the login was
    // already recorded, because the second pass had nothing left to change.
    await pool.query(
      `UPDATE auth_profiles
       SET health = CASE WHEN $2::text IS NULL THEN 'unknown' ELSE 'healthy' END
       WHERE id = $1
         AND health IS DISTINCT FROM CASE WHEN $2::text IS NULL THEN 'unknown' ELSE 'healthy' END`,
      [profile, signedIn ? dir : null],
    );

    const r = await pool.query(
      `UPDATE auth_profiles SET harness_auth_dir = $2
       WHERE id = $1 AND ($2::text IS DISTINCT FROM harness_auth_dir)
       RETURNING id`,
      [profile, signedIn ? dir : null],
    );
    if (!r.rowCount) continue;

    if (signedIn) {
      console.log(`harness login detected: ${profile}`);
      await pool.query(
        `UPDATE issues
         SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')`,
        [`setup.login.${profile}`],
      );
    } else {
      // A signed-out profile is not usable; the blocker will be re-raised by
      // ensureBlockedIssues on its next pass rather than silently staying clear.
      console.log(`harness login gone: ${profile}`);
    }
  }
}

async function main() {
  const pool = createPool();
  await ensureDirs();
  console.log(`worker ${WORKER_ID} starting`);
  for (;;) {
    try {
      await detectHostLogins(pool).catch(() => undefined);
      await fireDueSchedules(pool);
      await watchdog(pool);
      await drainOutbox(pool);
      await audioRetention(pool);
      await reapWorktrees(pool).catch(() => undefined);
      const id = await claimTask(pool, "system", WORKER_ID);
      if (id) {
        await runSystemTask(pool, id);
        continue;
      }
      // The heavy lane belongs to `jarvis-runner` on the host now (ADR 015).
      // This worker deliberately does not claim from it: both processes would
      // claim with the same SKIP LOCKED query, so whichever won the race would
      // decide the task's fate, and a share of every workload would be parked by
      // a container that cannot spawn a harness instead of run by the process
      // that can.
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.error(err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
