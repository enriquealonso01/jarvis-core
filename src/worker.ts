import { createPool } from "./db.js";
import { claimTask, runSystemTask, transitionTask } from "./jobs.js";
import { backoffSeconds, raiseIssue } from "./notify.js";
import { cronMatches } from "./cron.js";
import fs from "node:fs/promises";
import path from "node:path";

const WORKER_ID = process.env.WORKER_ID ?? "system-1";
const ARTIFACTS = "/var/lib/jarvis/artifacts";
const WORKTREES = "/var/lib/jarvis/worktrees";

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

async function watchdog(pool: ReturnType<typeof createPool>) {
  const stale = await pool.query<{ id: string; lane: string }>(
    `SELECT id, lane FROM tasks
     WHERE state IN ('running','preparing')
       AND heartbeat_at IS NOT NULL
       AND heartbeat_at < now() - interval '90 seconds'`,
  );
  for (const t of stale.rows) {
    const lane = t.lane;
    // STATE_MACHINES.md: stalled, then recovering, then back to the queue —
    // each step recorded so the Work view shows what the watchdog did.
    await transitionTask(pool, t.id, "stalled", "heartbeat missed for 90s", "watchdog");
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

async function ensureDirs() {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.mkdir(WORKTREES, { recursive: true });
  await fs.mkdir("/var/lib/jarvis/projects", { recursive: true });

  // ADR 006: one host-login directory per auth profile, 0700, never shared
  // between profiles. The layout is created at boot so a harness login has
  // somewhere correct to land rather than the CLI choosing for itself.
  const HARNESS_AUTH = "/var/lib/jarvis/harness-auth";
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
    const dir = `/var/lib/jarvis/harness-auth/${profile}`;
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
      const id = await claimTask(pool, "system", WORKER_ID);
      if (id) {
        await runSystemTask(pool, id);
        continue;
      }
      const heavy = await claimTask(pool, "heavy", WORKER_ID);
      if (heavy) {
        // The heavy lane still parks, but it must say why *truthfully*. The old
        // message asked Enrique to complete a host CLI login; those are done, so
        // it was sending him to do something already finished. What is actually
        // missing is the runner: the CLIs live on the host and the worker is a
        // container that mounts every profile dir as root, which is not the
        // one-profile-one-worktree shape ADR 006 requires.
        const logins = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM auth_profiles
           WHERE auth_type = 'subscription_login' AND harness_auth_dir IS NOT NULL`,
        );
        const haveLogin = Number(logins.rows[0]?.n ?? 0) > 0;

        // Both halves are constants chosen here, not interpolated from input:
        // transitionTask takes a raw SQL fragment, and building that from a
        // variable is a habit worth not starting.
        const [reason, waitingSql] = haveLogin
          ? [
              "harness runner not built yet — host logins are connected",
              "waiting_reason = 'harness runner not built yet', lease_until = NULL",
            ]
          : [
              "ACP harness host login not on this box yet",
              "waiting_reason = 'ACP harness host login not on this box yet', lease_until = NULL",
            ];

        await transitionTask(pool, heavy, "waiting_for_provider", reason, "worker", waitingSql);

        await raiseIssue(pool, {
          category: "harness.crash",
          service: "harness",
          owner: "user",
          status: "waiting_for_user",
          title: haveLogin
            ? "[harness] heavy lane needs a harness runner"
            : "[harness] heavy task waiting for Anthropic/Codex/Cursor host login",
          // Keyed on which condition is blocking, so resolving the login does not
          // leave the old ticket standing and does not silence the new one.
          dedupeKey: haveLogin ? "setup.harness.runner" : "setup.harness",
          taskId: heavy,
          evidence: { task_id: heavy, host_logins_connected: haveLogin },
          requiredAction: haveLogin
            ? "Decide how the harness runs: the CLIs are installed on the host, "
              + "while the worker is a container mounting every profile dir as root. "
              + "ADR 006 wants one profile dir and one worktree per run."
            : "Complete one of the host CLI logins on the VPS (ADR 006).",
          notifyOverride: "whatsapp_blocker",
        });
        continue;
      }
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
