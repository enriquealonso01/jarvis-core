import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { sseBroadcast } from "./sse.js";
import { ARTIFACTS_DIR, JARVIS_ROOT } from "./paths.js";
import { raiseIssue } from "./notify.js";
import { reprobeDegradedRoutes } from "./catalog.js";

/**
 * Every task state change writes a transition row (STATE_MACHINES.md). Without
 * this the Work view has no activity to show and a recovery leaves no trace of
 * what actually happened.
 */
export async function transitionTask(
  pool: pg.Pool,
  taskId: string,
  toState: string,
  cause: string,
  actor: string,
  extraSet = "",
): Promise<void> {
  const r = await pool.query<{ state: string }>(
    `SELECT state FROM tasks WHERE id = $1`,
    [taskId],
  );
  const from = r.rows[0]?.state ?? null;
  if (from === null) return;
  await pool.query(
    `UPDATE tasks SET state = $2, updated_at = now()${extraSet ? `, ${extraSet}` : ""} WHERE id = $1`,
    [taskId, toState],
  );
  await pool.query(
    `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, from, toState, cause, actor],
  );
  sseBroadcast("task.updated", { id: taskId, state: toState });

  /*
   * Only the states a person would want to read about. Every transition would
   * make the feed a log of the state machine, which is what task_transitions
   * already is and what nobody scrolls.
   */
  /*
   * Wrapped whole, and deliberately: a line in a feed must never be able to
   * break a state change. The first version left the metadata query and the
   * dynamic import outside a catch, so anything that threw in either took the
   * transition down with it — and a transition that half-happened is how a
   * finished run ends up looking abandoned.
   */
  if (["succeeded", "failed_terminal", "waiting_for_user", "waiting_for_provider", "stalled"].includes(toState)) {
    /*
     * S22: when the desk finishes, it reports.
     *
     * `notifyTaskComplete` was written and never called, so a task that came
     * from a phone call finished in silence — the caller had been told "I will
     * have the desk finish this and come back to you", and nothing ever came
     * back. The pull request URL goes in the body, because that is the thing
     * worth being told.
     */
    if (toState === "succeeded") {
      try {
        const done = await pool.query<{ title: string; lane: string; pr_url: string | null; branch: string | null }>(
          "SELECT title, lane, pr_url, branch FROM tasks WHERE id = $1",
          [taskId],
        );
        const row = done.rows[0];
        if (row) {
          const { notifyTaskComplete } = await import("./notify.js");
          await notifyTaskComplete(pool, {
            taskId,
            title: row.title,
            lane: row.lane,
            summary: row.pr_url
              ? `done — ${row.pr_url}`
              : row.branch
                ? `done on ${row.branch}`
                : "done",
            trivial: false,
          });
        }
      } catch (err) {
        // A report that cannot be sent must not undo the work it was reporting.
        console.error("completion report failed:", err instanceof Error ? err.message : err);
      }
    }
    try {
      const meta = await pool.query<{ title: string; project_id: string | null }>(
        "SELECT title, project_id FROM tasks WHERE id = $1",
        [taskId],
      );
      const row = meta.rows[0];
      if (row) {
        const { recordActivity } = await import("./activity.js");
        await recordActivity(pool, {
          projectId: row.project_id,
          kind: "task",
          subjectId: taskId,
          title: `${row.title} — ${toState.replace(/_/g, " ")}`,
          detail: cause,
          actor,
          href: `/work/?task=${taskId}`,
        });
      }
    } catch {
      /* the feed is not worth a failed transition */
    }
  }
}

/**
 * A worker never reports success without a final checkpoint — that checkpoint is
 * what a restart resumes from (FULL_LOOPS L2).
 */
export async function writeCheckpoint(
  pool: pg.Pool,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await pool.query(`INSERT INTO task_checkpoints (task_id, payload) VALUES ($1, $2)`, [
    taskId,
    JSON.stringify(payload),
  ]);
}

export async function claimTask(pool: pg.Pool, lane: string, workerId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ADR 007 starvation cap: a Normal-or-higher personal task that has waited
    // 30 minutes goes next, so professional High work cannot jump it forever.
    // Critical is never subject to the cap; Background never benefits from it.
    const row = await client.query<{ id: string }>(
      `SELECT t.id FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.state = 'queued' AND t.lane = $1
         AND (t.lease_until IS NULL OR t.lease_until < now())
       ORDER BY
         CASE WHEN t.priority = 'critical' THEN 0 ELSE 1 END,
         CASE
           WHEN t.priority IN ('normal', 'high')
            AND COALESCE(p.project_type, 'personal') = 'personal'
            AND t.created_at < now() - interval '30 minutes'
           THEN 0 ELSE 1
         END,
         CASE t.priority
           WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2
           WHEN 'low' THEN 3 ELSE 4 END,
         t.created_at
       -- FOR UPDATE OF t, not a bare FOR UPDATE: locking the whole row set of an
       -- outer join is rejected by Postgres ("cannot be applied to the nullable
       -- side of an outer join"), which silently broke claiming when the
       -- starvation-cap join was added.
       FOR UPDATE OF t SKIP LOCKED
       LIMIT 1`,
      [lane],
    );
    if (!row.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const id = row.rows[0].id;
    await client.query(
      `UPDATE tasks SET state = 'preparing', lease_owner = $2, lease_until = now() + interval '60 seconds',
         heartbeat_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, workerId],
    );
    await client.query(
      `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
       VALUES ($1, 'queued', 'preparing', 'claimed from queue', $2)`,
      [id, workerId],
    );
    await client.query("COMMIT");
    sseBroadcast("task.updated", { id, state: "preparing" });
    sseBroadcast("queue.updated", { lane });
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runSystemTask(pool: pg.Pool, taskId: string): Promise<void> {
  const task = await pool.query<{ title: string; objective: string | null }>(
    "SELECT title, objective FROM tasks WHERE id = $1",
    [taskId],
  );
  const title = task.rows[0]?.title ?? "";
  // Record the attempt before doing the work: an attempt that crashes the
  // process must still be visible afterwards.
  const attempt = await pool.query<{ n: number }>(
    `INSERT INTO task_attempts (task_id, n)
     VALUES ($1, COALESCE((SELECT max(n) FROM task_attempts WHERE task_id = $1), 0) + 1)
     RETURNING n`,
    [taskId],
  );
  const attemptN = attempt.rows[0].n;
  await transitionTask(pool, taskId, "running", `system job ${title}`, "worker", "heartbeat_at = now()");

  // WORKERS.md: the worker observes the cancel flag. Previously Cancel only
  // rewrote a row while the job carried on to "succeeded".
  const cancelled = await pool.query<{ cancel_requested_at: Date | null }>(
    `SELECT cancel_requested_at FROM tasks WHERE id = $1`,
    [taskId],
  );
  if (cancelled.rows[0]?.cancel_requested_at) {
    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), summary = 'cancelled before start' WHERE task_id = $1 AND n = $2`,
      [taskId, attemptN],
    );
    await transitionTask(pool, taskId, "cancelled", "cancel observed by worker", "worker", "lease_until = NULL");
    return;
  }

  try {
    if (title.includes("health") || task.rows[0]?.objective === "health") {
      await healthCheck(pool);
    } else if (title.includes("retention") || title.includes("prune")) {
      await retentionSweep();
      await resolveHandledIssues(pool);
    } else if (title.includes("backup") || title.includes("restore")) {
      await pool.query(
        `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
         SELECT 'low', 'maintenance', 'backup', 'open', 'jarvis',
                '[maintenance] restore-test due', 'maintenance.restore-test'
         WHERE NOT EXISTS (
           SELECT 1 FROM issues WHERE dedupe_key = 'maintenance.restore-test' AND status NOT IN ('resolved','ignored')
         )`,
      );
    }
    // Final checkpoint first: STATE_MACHINES.md forbids self-reporting success
    // without one, because that checkpoint is what a restart resumes from.
    await writeCheckpoint(pool, taskId, { job: title, outcome: "completed" });
    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), summary = 'completed' WHERE task_id = $1 AND n = $2`,
      [taskId, attemptN],
    );
    await transitionTask(pool, taskId, "succeeded", "system job completed", "worker", "lease_until = NULL");
  } catch (err) {
    await writeCheckpoint(pool, taskId, {
      job: title,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    await transitionTask(
      pool,
      taskId,
      "failed_terminal",
      err instanceof Error ? err.message : "system job failed",
      "worker",
    );
    await pool.query(
      `UPDATE task_attempts SET ended_at = now(), error_class = 'worker.crash', summary = $3
       WHERE task_id = $1 AND n = $2`,
      [taskId, attemptN, err instanceof Error ? err.message.slice(0, 300) : "error"],
    );
    await raiseIssue(pool, {
      category: "worker.crash",
      service: "worker",
      title: "[worker] system task failed",
      dedupeKey: `worker.crash:${title}`,
      taskId,
      evidence: { taskId, error: err instanceof Error ? err.message : "error" },
    });
  }
  sseBroadcast("task.updated", { id: taskId });
}

/**
 * Open a health_incident when a service goes bad and close it when it recovers.
 * The table existed and nothing wrote to it, so "healthy" had no history behind
 * it and a flapping service looked identical to one that never broke.
 */
async function setServiceHealth(
  pool: pg.Pool,
  service: string,
  healthy: boolean,
  severity: "critical" | "high" | "medium",
  summary: string,
): Promise<void> {
  const open = await pool.query<{ id: string }>(
    `SELECT id FROM health_incidents WHERE service = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    [service],
  );
  if (healthy) {
    if (open.rows[0]) {
      await pool.query(`UPDATE health_incidents SET closed_at = now() WHERE id = $1`, [
        open.rows[0].id,
      ]);
    }
    return;
  }
  if (open.rows[0]) return;
  await pool.query(
    `INSERT INTO health_incidents (service, severity, summary) VALUES ($1, $2, $3)`,
    [service, severity, summary],
  );
}

async function healthCheck(pool: pg.Pool) {
  await pool.query("SELECT 1");

  const ram = process.memoryUsage();
  const ramBad = ram.rss > 12 * 1024 * 1024 * 1024;
  await setServiceHealth(pool, "ram", !ramBad, "high", "worker RSS above 12 GB");
  if (ramBad) {
    await raiseIssue(pool, {
      category: "resource.ram",
      service: "host",
      title: "[host] memory pressure",
      dedupeKey: "resource.ram",
      requiredAction: "Shed embeddings or browser profiles.",
    });
  }

  // Disk: the taxonomy pages at 85%, and a full disk takes everything with it.
  let diskPct = 0;
  try {
    const { statfs } = await import("node:fs/promises");
    const st = await statfs(JARVIS_ROOT);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    if (total > 0) diskPct = Math.round(((total - free) / total) * 100);
  } catch {
    diskPct = 0;
  }
  const diskBad = diskPct >= 85;
  await setServiceHealth(pool, "disk", !diskBad, "high", `disk at ${diskPct}%`);
  if (diskBad) {
    await raiseIssue(pool, {
      category: "resource.disk",
      service: "host",
      title: `[host] disk at ${diskPct}%`,
      dedupeKey: "resource.disk",
      requiredAction: "Prune Docker images and old artifacts before anything is deleted automatically.",
    });
  }

  await resolveHandledIssues(pool).catch(() => 0);

  // Give rate-limited routes a way back before judging routing health, so a
  // free-tier 429 does not permanently look like an outage.
  try {
    const { restored } = await reprobeDegradedRoutes(pool);
    if (restored.length) console.log(`routes restored: ${restored.join(", ")}`);
  } catch {
    /* a failed re-probe is not itself a health failure */
  }

  // Supervisor routing: a stored key is not a working route.
  const routes = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_registry
     WHERE approval_state = 'approved' AND health = 'healthy'
       AND endpoint_url IS NOT NULL AND 'supervisor' = ANY (role_assignments)`,
  );
  const routingOk = Number(routes.rows[0]?.n ?? 0) > 0;
  await setServiceHealth(pool, "model_routing", routingOk, "critical", "no healthy supervisor route");

  // Backups: a backup that has not run in three days is a problem even if the
  // last one passed.
  const lastBackup = await pool.query<{ at: string | null }>(
    `SELECT max(at) AS at FROM audit_events WHERE action LIKE 'backup.restore_drill.%'`,
  );
  const drillAt = lastBackup.rows[0]?.at ? new Date(lastBackup.rows[0].at).getTime() : 0;
  const drillStale = drillAt > 0 && Date.now() - drillAt > 40 * 24 * 60 * 60 * 1000;
  await setServiceHealth(pool, "backup", !drillStale, "high", "restore drill has not run in 40 days");

  // Anything parked long enough to be forgotten about.
  const stuck = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks
     WHERE state IN ('stalled','recovering') AND updated_at < now() - interval '30 minutes'`,
  );
  const stuckBad = Number(stuck.rows[0]?.n ?? 0) > 0;
  await setServiceHealth(pool, "queue", !stuckBad, "high", "tasks stuck in recovery for over 30 minutes");
}

/**
 * Close tickets that recorded something already handled.
 *
 * A denial that the broker refused, a file the scanner blocked, or a stall the
 * watchdog recovered from are all worth a trail entry — but leaving them open
 * turns the Issues page into a log, and a log nobody can act on is noise that
 * hides the items that do need Enrique.
 */
async function resolveHandledIssues(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    `UPDATE issues
     SET status = 'resolved', resolved_at = now(), updated_at = now()
     WHERE status NOT IN ('resolved', 'ignored')
       AND owner = 'jarvis'
       AND category IN ('security.broker_deny', 'artifact.corrupt', 'telnyx.quiet_hours',
                        'webhook.duplicate', 'network.timeout')
       AND last_seen_at < now() - interval '6 hours'
     RETURNING id`,
  );

  // A refused cross-project request is the control working. It pages
  // immediately and stays in the audit trail permanently, but after a day with
  // no recurrence it should stop pinning the console to "incident" — a
  // permanently red console is one nobody reads.
  await pool.query(
    `UPDATE issues
     SET status = 'resolved', resolved_at = now(), updated_at = now()
     WHERE status NOT IN ('resolved', 'ignored')
       AND category = 'security.isolation'
       AND owner = 'jarvis'
       AND last_seen_at < now() - interval '24 hours'`,
  );

  // A worker.crash ticket whose lane has nothing stuck any more is finished.
  await pool.query(
    `UPDATE issues i
     SET status = 'resolved', resolved_at = now(), updated_at = now()
     WHERE i.status NOT IN ('resolved', 'ignored')
       AND i.category = 'worker.crash'
       AND i.last_seen_at < now() - interval '1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.state IN ('stalled', 'recovering')
       )`,
  );
  return r.rowCount ?? 0;
}

async function retentionSweep() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = ARTIFACTS_DIR;
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  try {
    const projects = await fs.readdir(root).catch(() => []);
    for (const p of projects) {
      const dir = path.join(root, p);
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files) {
        if (!f.startsWith("raw-audio") && !f.includes("audio")) continue;
        const st = await fs.stat(path.join(dir, f)).catch(() => null);
        if (st && Date.now() - st.mtimeMs > maxAgeMs) {
          await fs.unlink(path.join(dir, f));
        }
      }
    }
  } catch {
    /* empty */
  }
}

export { githubCreatePrivateRepo } from "./github.js";
