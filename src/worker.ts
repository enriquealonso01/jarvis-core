import { connectClient, createPool } from "./db.js";
import { hostMetrics } from "./hostmetrics.js";
import { sampleResources } from "./activity.js";
import { startSseBridge } from "./sse.js";
import { claimTask, runSystemTask, transitionTask } from "./jobs.js";
import { backoffSeconds, raiseIssue } from "./notify.js";
import { cronMatches } from "./cron.js";
import {
  decideFire, gatherContext, minuteOf, noteMisfire, pauseForFailures, recordRun,
  type Overlap,
} from "./schedule.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where the OpenClaw bridge listens. Overridable so a test can point the worker
 * at a stand-in and assert the outbox state machine without a paired phone.
 */
const BRIDGE_SEND_URL = process.env.JARVIS_BRIDGE_SEND_URL ?? "http://openclaw:18789/jarvis/send";
import { ARTIFACTS_DIR, HARNESS_AUTH_DIR, PROJECTS_DIR, WORKTREES_DIR } from "./paths.js";
import { sweepCallDeadlines } from "./callcontrol.js";
import { recordBlindWindow, recordSweep, reconcileExpiredLeases } from "./selfwatch.js";
import { sweepOutboundCalls } from "./outbound.js";
import { audioRetention } from "./retention.js";

const WORKER_ID = process.env.WORKER_ID ?? "system-1";
const ARTIFACTS = ARTIFACTS_DIR;
const WORKTREES = WORKTREES_DIR;

/**
 * Fire what is due, and record what was not (plan S34).
 *
 * The decision lives in src/schedule.ts and is pure, so the awkward cases - a
 * box that was off for six hours, a run still in flight, a schedule that has
 * failed twice - are tested at any clock without running this loop. What is
 * left here is I/O.
 */
async function fireDueSchedules(pool: ReturnType<typeof createPool>) {
  const now = new Date();
  const scheduledFor = minuteOf(now);
  const rows = await pool.query<{
    id: string; name: string; project_id: string; cron: string; timezone: string;
    paused: boolean; overlap: string; failure_threshold: number | null;
  }>(
    `SELECT id, name, project_id, cron, timezone, paused, overlap, failure_threshold
       FROM schedules WHERE paused = false`,
  );
  for (const row of rows.rows) {
    if (!cronMatches(row.cron, scheduledFor, row.timezone || "America/New_York")) continue;
    const s = {
      id: row.id, name: row.name, projectId: row.project_id,
      overlap: row.overlap as Overlap, paused: row.paused,
      failureThreshold: row.failure_threshold,
    };
    const ctx = await gatherContext(pool, s.id, scheduledFor, s.failureThreshold ?? undefined);
    const decision = decideFire(s, scheduledFor, now, ctx);

    if (!decision.fire) {
      // Recorded, including the skips: a schedule that never runs and one that
      // was never due are the same row otherwise.
      if (decision.result !== "already_ran") {
        await recordRun(pool, { scheduleId: s.id, scheduledFor, result: decision.result });
      }
      if (decision.result === "skipped_misfire") {
        await noteMisfire(pool, s, scheduledFor, now.getTime() - scheduledFor.getTime());
      }
      if (decision.result === "paused" && ctx.consecutiveFailures > 0) {
        await pauseForFailures(pool, s, ctx.consecutiveFailures);
      }
      continue;
    }

    if (decision.replaces) {
      await pool.query(
        `UPDATE tasks SET state = 'cancelled', lease_owner = NULL, lease_until = NULL
          WHERE id = $1 AND state IN ('queued','preparing','running','recovering')`,
        [decision.replaces]);
    }
    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, priority, lane)
       VALUES ($1, $2, $2, 'queued', 'background', 'system') RETURNING id`,
      [s.projectId, s.name],
    );
    /*
     * The insert is the lock. If a second worker - or this one after a restart
     * mid-loop - reaches the same minute, the unique index refuses the row and
     * `recordRun` returns false, so the task it just created is withdrawn
     * rather than left to run twice.
     */
    const recorded = await recordRun(pool, {
      scheduleId: s.id, scheduledFor, taskId: task.rows[0].id, result: "fired",
    });
    if (!recorded) {
      await pool.query(`DELETE FROM tasks WHERE id = $1`, [task.rows[0].id]);
    }
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

    /*
     * S18b: climb the ladder rather than always doing the same thing.
     *
     * This used to be one action — requeue from the latest checkpoint — applied
     * to a two-second network blip and to a model that cannot do the job alike.
     * That is rung 7 of ten, so recovery could neither be cheaper than itself
     * nor escalate past itself. `climb` picks the cheapest rung not yet
     * exhausted for THIS task, applies it, and records it on the timeline.
     */
    const { climb } = await import("./ladder.js");
    const step = await climb(pool, t.id, `heartbeat missed for ${STALL_SECONDS}s`);
    console.log(`watchdog: task ${t.id} recovery rung ${step.rung} (${step.name}) — ${step.detail}`);

    // The recovery worked, so the ticket has served its purpose. It stays in the
    // trail as resolved rather than sitting open forever.
    await pool.query(
      `UPDATE issues
       SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')`,
      [`worker.crash:${lane}`],
    );
  }

  await climbParked(pool);
}

/**
 * Climb again for tasks an earlier rung parked.
 *
 * The stale query above only sees `running` and `preparing`, which was right
 * when recovery was a single action: requeue, and the task is running again by
 * the next tick. The ladder broke that assumption. Rung 1 is `wait`, which
 * leaves the task in `recovering` on purpose — and nothing ever looked at it
 * again, so a stalled task waited thirty seconds and then waited forever. It
 * cost S4's drain test, which is the only suite that drives the watchdog end to
 * end; the ladder's own test called `climb()` in a loop and so never noticed
 * that in production nothing calls it twice.
 */
async function climbParked(pool: ReturnType<typeof createPool>) {
  const { climb, backoffSecondsFor } = await import("./ladder.js");
  const parked = await pool.query<{ id: string; rung: string; waited: number }>(
    `SELECT t.id, e.name AS rung, EXTRACT(epoch FROM now() - e.at)::int AS waited
     FROM tasks t
     JOIN LATERAL (
       SELECT name, at FROM task_events
       WHERE task_id = t.id AND type = 'recovery'
       ORDER BY at DESC, id DESC LIMIT 1
     ) e ON true
     WHERE t.state = 'recovering'`,
  );
  for (const t of parked.rows) {
    if (t.waited < backoffSecondsFor(t.rung)) continue;
    const step = await climb(pool, t.id, `rung ${t.rung} did not resolve it after ${t.waited}s`);
    console.log(`watchdog: task ${t.id} climbs to rung ${step.rung} (${step.name}) — ${step.detail}`);
  }
}

export async function drainOutbox(pool: ReturnType<typeof createPool>) {
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
  /*
   * A channel proven absent this pass is not asked again.
   *
   * Each send spawns a CLI process and waits about three seconds for it to
   * refuse, so nineteen queued notifications meant a minute of spawning per
   * sweep to learn one fact - that the phone is not paired - nineteen times.
   */
  const unpaired = new Set<string>();

  for (const n of rows.rows) {
    if (n.channel === "ui") {
      await pool.query(`UPDATE notifications_outbox SET state = 'sent', attempts = attempts + 1 WHERE id = $1`, [n.id]);
      continue;
    }
    // Hand it to the bridge, which owns the channel. Everything about the
    // retry curve below is unchanged: a send that does not succeed lands in
    // exactly the state it landed in when there was no transport at all.
    const sent = unpaired.has(n.channel)
      ? { ok: false, unavailable: true, detail: `${n.channel} is not paired` }
      : await sendViaBridge(pool, n.id);
    if (sent.ok) {
      await pool.query(
        `UPDATE notifications_outbox SET state = 'sent', attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [n.id],
      );
      continue;
    }
    /*
     * "Not paired yet" is not a failed attempt.
     *
     * Wiring the outbox to a real transport turned a channel that never sent
     * anything into one that tries and is refused, and the retry curve would
     * then spend all seven attempts before Enrique had scanned the QR: the
     * queue would reach `failed`, the revive sweep would resurrect it, and the
     * pair would loop forever while spawning a CLI process per row per sweep.
     * Deferring instead keeps the queue intact and idle until a channel exists,
     * which is what "on pairing each must arrive exactly once, not zero" needs.
     * Every other failure still walks the taxonomy curve untouched.
     */
    if (sent.unavailable) {
      unpaired.add(n.channel);
      await pool.query(
        `UPDATE notifications_outbox
         SET last_error = 'channel not paired yet; deferred without spending an attempt',
             next_attempt_at = now() + interval '5 minutes'
         WHERE id = $1`,
        [n.id],
      );
      continue;
    }
    // Back off on the taxonomy curve instead of hammering a flat interval.
    const attempts = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM notifications_outbox WHERE id = $1`,
      [n.id],
    );
    const next = backoffSeconds((attempts.rows[0]?.attempts ?? 0) + 4);
    await pool.query(
      `UPDATE notifications_outbox
       SET attempts = attempts + 1, last_error = $3,
           next_attempt_at = now() + ($2 || ' seconds')::interval,
           state = CASE WHEN attempts >= 7 THEN 'failed' ELSE 'pending' END
       WHERE id = $1`,
      [n.id, String(next), sent.detail.slice(0, 500)],
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
/**
 * Deliver one queued notification through the OpenClaw bridge.
 *
 * The worker cannot run the OpenClaw CLI - different container, and no Docker
 * socket by design - so the bridge exposes one HMAC-authenticated route and
 * performs the send with OpenClaw's own machinery. The signature is over the
 * exact bytes, and it is the same INTERNAL_HMAC the inbound direction uses.
 *
 * Exactly once, which is the property Enrique asked for, is held in two places
 * because one is not enough:
 *
 *   here    a row is marked sent only after a 2xx, so a failure retries.
 *   bridge  the row id is remembered after a successful send, so a crash
 *           between the send and the mark does not deliver twice on retry.
 *
 * The recipient is the commanding identity from `channel_allowlist` rather than
 * anything in the row: the outbox stores what to say, not who to say it to.
 */
async function sendViaBridge(
  pool: ReturnType<typeof createPool>,
  id: string,
): Promise<{ ok: boolean; unavailable: boolean; detail: string }> {
  const secret = process.env.INTERNAL_HMAC;
  if (!secret) return { ok: false, unavailable: false, detail: "INTERNAL_HMAC missing" };

  const row = await pool.query<{ body: string; channel: string; identifier: string | null }>(
    `SELECT o.body, o.channel,
            (SELECT identifier FROM channel_allowlist a
              WHERE a.channel = o.channel AND a.can_command ORDER BY a.id LIMIT 1) AS identifier
       FROM notifications_outbox o WHERE o.id = $1`,
    [id],
  );
  const n = row.rows[0];
  if (!n) return { ok: false, unavailable: false, detail: "row vanished" };
  if (!n.identifier) return { ok: false, unavailable: false, detail: `no commanding identity for channel ${n.channel}` };

  const body = JSON.stringify({ id, to: n.identifier, text: n.body, channel: n.channel });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  try {
    const res = await fetch(BRIDGE_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jarvis-Internal": signature },
      body,
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    // The flag if the bridge sent one; the words only as a fallback, since the
    // text this reads is truncated and the words can fall off the end.
    let unavailable = /channel is unavailable|not paired/i.test(text);
    try {
      unavailable = JSON.parse(text).unavailable === true || unavailable;
    } catch { /* not JSON: keep the fallback */ }
    return { ok: res.ok, unavailable, detail: `${res.status} ${text.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, unavailable: false, detail: `bridge unreachable: ${String((err as Error).message ?? err)}` };
  }
}

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
  // Forward only. The watchdog's stalled -> recovering -> queued is the most
  // useful thing the console can show live, and it was happening in a process
  // no browser is connected to.
  await startSseBridge(connectClient, { listen: false }).catch(() => undefined);

  /*
   * S18: keep the history the trend needs.
   *
   * Host metrics were computed live and thrown away, so the console could say
   * "disk is at 84%" and never "disk has climbed nine points this week", and
   * Maintenance could only act after a threshold rather than before it. One
   * sample every five minutes is 288 rows a day — nothing, and enough for a
   * slope.
   */
  const sampler = setInterval(() => {
    void hostMetrics().then((h) => sampleResources(pool, h)).catch(() => undefined);
  }, 5 * 60_000);
  sampler.unref();
  void hostMetrics().then((h) => sampleResources(pool, h)).catch(() => undefined);

  /*
   * Coming back blind (plan II.3).
   *
   * A watchdog that restarts has to reconcile the window it missed rather than
   * beginning at zero. The gap goes on the timeline because forty unwatched
   * minutes otherwise render as forty healthy ones, and leases are reconciled
   * on the first sweep because a worker that died during that window holds one
   * nobody released - and on this hardware, one held lease in the heavy lane is
   * the entire lane.
   */
  const blind = await recordBlindWindow(pool, "watchdog", WORKER_ID).catch(() => null);
  if (blind !== null) console.log(`watchdog: blind window of ${blind}s before this worker started`);
  const freed = await reconcileExpiredLeases(pool).catch(() => 0);
  if (freed) console.log(`watchdog: released ${freed} expired lease(s) from the blind window`);

  console.log(`worker ${WORKER_ID} starting`);
  for (;;) {
    try {
      await detectHostLogins(pool).catch(() => undefined);
      await fireDueSchedules(pool);
      await watchdog(pool);
      /*
       * After it returns, never before. A sweep recorded on entry says the
       * watchdog was called; recorded here it says the watchdog finished, and
       * only the second one distinguishes a working component from one wedged
       * on a database call.
       */
      await recordSweep(pool, "watchdog", WORKER_ID).catch(() => undefined);
      await drainOutbox(pool);
      await audioRetention(pool);
      // A leg deadline that only exists inside the request that started it dies
      // with the process. Swept from out here, a call survives an API restart.
      for (const note of await sweepCallDeadlines(pool).catch(() => [] as string[])) {
        console.log(`call sweep: ${note}`);
      }
      // S23: the six reasons Jarvis may ring Enrique, and no others.
      for (const note of await sweepOutboundCalls(pool).catch((err) => {
        console.error("outbound call sweep failed:", err instanceof Error ? err.message : err);
        return [] as string[];
      })) {
        console.log(`outbound: ${note}`);
      }
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

/*
 * Only when this file IS the process, never on import.
 *
 * The outbox sweep has to be callable from a test - "exactly once" is a claim
 * about repeated sweeps, and the only honest way to assert it is to sweep more
 * than once and count. Importing the module used to start the whole worker
 * loop, so the guard is what makes that test possible at all.
 */
const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
