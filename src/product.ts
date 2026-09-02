import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { ARTIFACTS_DIR, BROWSERS_DIR, WORKTREES_DIR } from "./paths.js";
import { requireUser } from "./auth.js";
import { ingestUserMessage } from "./inbox.js";
import { checksum } from "./supervisor.js";
import { sseAdd, sseBroadcast, sseHeartbeat } from "./sse.js";
import { internalIdempotency, requestRawBody, verifyInternalHmac } from "./hmac.js";
import { verifyTelnyxWebhook } from "./telnyx.js";
import { storeUpload, type StoredUpload } from "./uploads.js";
import { taskTiming } from "./timing.js";
import {
  githubCreatePrivateRepo,
  githubProvisionDeployKey,
  githubCreatePullRequest,
  githubMergePullRequest,
} from "./github.js";
import { readJsonCredential } from "./credentials.js";
import { inQuietHours, isAlwaysConfirm, validEnum, validSlug } from "./policy.js";
import { transitionTask } from "./jobs.js";
import { audit } from "./audit.js";
import { raiseIssue } from "./notify.js";
import { cronNextRun } from "./cron.js";
import { audioDir, handleCallEvent, renderSpeech, type TelnyxEvent } from "./callcontrol.js";
import { bindingSha, level3ThisHour, LEVEL3_HOURLY_CEILING, reauthFresh, sessionKey } from "./reauth.js";
import { delegateToDesk, triage } from "./callagent.js";
import fsp from "node:fs/promises";
import path from "node:path";

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export function registerProductRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/inbox", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const q = req.query as { state?: string; channel?: string; limit?: string; before?: string };
    const state = q.state && q.state !== "all" ? q.state : null;
    const channel = q.channel && q.channel !== "all" ? q.channel : null;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);

    // The inbox grows without bound, so it pages by received_at rather than
    // silently truncating at a fixed cap and looking complete.
    const r = await pool.query(
      `SELECT id, channel, sender, raw_text, capture_state, processing_state,
              project_id, conversation_id, received_at,
              array_length(artifact_ids, 1) AS attachment_count
       FROM inbox_events
       WHERE ($1::text IS NULL OR processing_state = $1)
         AND ($2::text IS NULL OR channel = $2)
         AND ($3::timestamptz IS NULL OR received_at < $3)
       ORDER BY received_at DESC
       LIMIT $4`,
      [state, channel, q.before ?? null, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    const totals = await pool.query<{ total: string; pending: string; failed: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE processing_state = 'pending')::text AS pending,
              count(*) FILTER (WHERE processing_state = 'failed')::text AS failed
       FROM inbox_events`,
    );
    return {
      inbox: page,
      has_more: r.rows.length > limit,
      next_before: page.length ? page[page.length - 1].received_at : null,
      totals: {
        all: Number(totals.rows[0]?.total ?? 0),
        pending: Number(totals.rows[0]?.pending ?? 0),
        failed: Number(totals.rows[0]?.failed ?? 0),
      },
    };
  });

  app.get("/api/inbox/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query(`SELECT * FROM inbox_events WHERE id = $1`, [id]);
    if (!r.rows[0]) return reply.code(404).send({ error: "not found" });
    return r.rows[0];
  });

  app.post("/api/inbox/:id/reroute", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const projectId = ((req.body ?? {}) as { project_id?: string }).project_id ?? null;
    const prev = await pool.query<{ project_id: string | null }>(
      "SELECT project_id FROM inbox_events WHERE id = $1",
      [id],
    );
    await pool.query(`UPDATE inbox_events SET project_id = $2, processing_state = 'pending' WHERE id = $1`, [
      id,
      projectId,
    ]);
    await pool.query(
      `INSERT INTO routing_overrides (inbox_event_id, from_project, to_project, actor)
       VALUES ($1, $2, $3, 'user')`,
      [id, prev.rows[0]?.project_id ?? null, projectId],
    );
    return { ok: true };
  });

  app.post("/api/inbox", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });

    let text = "";
    let conversationId: string | undefined;
    const uploads: StoredUpload[] = [];

    if (req.isMultipart()) {
      // Persist-first applies to bytes too: each file is written and recorded
      // before anything reads it, and nothing is handed to a model unscanned.
      try {
        for await (const part of req.parts()) {
          if (part.type === "file") {
            const conv = conversationId
              ? await pool.query<{ project_id: string | null }>(
                  "SELECT project_id FROM conversations WHERE id = $1",
                  [conversationId],
                )
              : null;
            uploads.push(
              await storeUpload(pool, {
                stream: part.file,
                filename: part.filename,
                mimetype: part.mimetype ?? null,
                projectId: conv?.rows[0]?.project_id ?? null,
                inboxEventId: null,
              }),
            );
          } else if (part.fieldname === "body") {
            text = String(part.value ?? "");
          } else if (part.fieldname === "conversation_id") {
            conversationId = String(part.value ?? "") || undefined;
          }
        }
      } catch (err) {
        return reply.code(413).send({
          error: {
            code: "upload_rejected",
            message: err instanceof Error ? err.message : "upload failed",
          },
        });
      }
    } else {
      const body = (req.body ?? {}) as { body?: string; conversation_id?: string };
      text = body.body ?? "";
      conversationId = body.conversation_id;
    }

    const convId =
      conversationId ??
      (
        await pool.query<{ id: string }>(
          `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
        )
      ).rows[0]?.id;
    if (!convId) return reply.code(400).send({ error: "no conversation" });

    const blocked = uploads.filter((u) => u.quarantineState === "blocked");
    // The model is told what arrived, never the contents of an unscanned file.
    const attachmentNote = uploads.length
      ? `\n\n[attachments: ${uploads
          .map(
            (u) =>
              `${u.filename} (${u.bytes} bytes, ${u.quarantineState}${u.reason ? `: ${u.reason}` : ""})`,
          )
          .join("; ")}]`
      : "";

    if (!text.trim() && !uploads.length) {
      return reply.code(400).send({ error: "nothing to ingest" });
    }

    const result = await ingestUserMessage(pool, {
      conversationId: convId,
      body: `${text}${attachmentNote}`.trim() || "(attachment only)",
    });

    // Link the artifacts to the inbox event now that it exists.
    if (uploads.length && result.inboxId) {
      await pool.query(`UPDATE artifacts SET inbox_event_id = $2 WHERE id = ANY($1::uuid[])`, [
        uploads.map((u) => u.artifactId),
        result.inboxId,
      ]);
      await pool.query(`UPDATE inbox_events SET artifact_ids = $2::uuid[] WHERE id = $1`, [
        result.inboxId,
        uploads.map((u) => u.artifactId),
      ]);
    }

    for (const b of blocked) {
      await raiseIssue(pool, {
        category: "artifact.corrupt",
        service: "uploads",
        title: `[uploads] refused ${b.filename}`,
        dedupeKey: `upload.blocked:${b.sha256}`,
        evidence: { filename: b.filename, reason: b.reason, sha256: b.sha256 },
        requiredAction:
          "The file was stored but is not served or read by any model. Re-send it in a supported format if it was expected.",
      });
    }

    sseBroadcast("conversation.message", { conversation_id: convId });
    if (result.error) return reply.code(502).send({ ...result, attachments: uploads });
    return { ...result, attachments: uploads };
  });

  app.get("/api/conversations/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const c = await pool.query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    if (!c.rows[0]) return reply.code(404).send({ error: "not found" });
    const messages = await pool.query(
      `SELECT id, role, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at`,
      [id],
    );
    return { conversation: c.rows[0], messages: messages.rows };
  });

  // A background schedule fires every few minutes and books a task each time.
  // Those are heartbeats, not work Enrique needs to look at, so the console
  // rolls them up instead of listing 288 rows a day.
  const ROUTINE_PREDICATE = `EXISTS (
      SELECT 1 FROM schedule_runs sr
      JOIN schedules sc ON sc.id = sr.schedule_id
      WHERE sr.task_id = t.id AND sc.priority = 'background'
    )`;

  app.get("/api/tasks", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const includeRoutine = (req.query as { routine?: string }).routine === "1";
    const r = await pool.query(
      `SELECT t.id, t.title, t.objective, t.state, t.priority, t.lane, t.project_id,
              t.model_role, t.harness, t.branch, t.waiting_reason, t.created_at, t.updated_at,
              p.slug AS project_slug, p.name AS project_name
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${includeRoutine ? "true" : `NOT (t.state = 'succeeded' AND ${ROUTINE_PREDICATE})`}
       ORDER BY t.updated_at DESC LIMIT 100`,
    );
    // 100 is a page, not the truth: there are already more tasks than that, so
    // per-lane counts taken from the page above would understate the queue.
    const t = await pool.query<{
      all: string; supervisor: string; heavy: string; system: string; active: string;
    }>(
      `SELECT count(*)::text AS all,
              count(*) FILTER (WHERE lane = 'supervisor')::text AS supervisor,
              count(*) FILTER (WHERE lane = 'heavy')::text AS heavy,
              count(*) FILTER (WHERE lane = 'system')::text AS system,
              count(*) FILTER (WHERE state NOT IN
                ('succeeded','failed_terminal','cancelled'))::text AS active
       FROM tasks`,
    );
    const row = t.rows[0];
    return {
      tasks: r.rows,
      totals: {
        all: Number(row.all),
        supervisor: Number(row.supervisor),
        heavy: Number(row.heavy),
        system: Number(row.system),
        active: Number(row.active),
      },
    };
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `SELECT t.*, p.slug AS project_slug, p.name AS project_name
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [id],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not found" });

    const [transitions, checkpoints, events, attempts, grants, issues, approvals, artifacts, origin] =
      await Promise.all([
      pool.query(
        `SELECT from_state, to_state, cause, actor, at
         FROM task_transitions WHERE task_id = $1 ORDER BY at`,
        [id],
      ),
      pool.query(`SELECT id, at, payload FROM task_checkpoints WHERE task_id = $1 ORDER BY at`, [id]),
      pool.query(
        `SELECT id, at, type, name, summary, artifact_id
         FROM task_events WHERE task_id = $1 ORDER BY at DESC LIMIT 200`,
        [id],
      ),
      pool.query(
        `SELECT n, started_at, ended_at, error_class, summary
         FROM task_attempts WHERE task_id = $1 ORDER BY n`,
        [id],
      ),
      pool.query(
        `SELECT id, actions, repo, environment, allowed_sha FROM task_grants WHERE task_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT id, severity, category, status, title FROM issues WHERE task_id = $1 ORDER BY created_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT id, action_type, target, environment, resource_version, state, expires_at, decided_at
         FROM approvals WHERE task_id = $1 ORDER BY COALESCE(decided_at, expires_at) DESC NULLS LAST`,
        [id],
      ),
      // S14: the files the run produced. `artifacts` has no task_id — it is
      // keyed by project and inbox event — so the link is the artifact_id the
      // worker put on its own event, which is the only record of which run made
      // which file.
      pool.query(
        `SELECT a.id, a.path, a.mime, a.bytes, a.created_at, a.quarantine_state
         FROM artifacts a
         JOIN task_events e ON e.artifact_id = a.id
         WHERE e.task_id = $1
         GROUP BY a.id
         ORDER BY a.created_at DESC`,
        [id],
      ),
      // Where the work came from. A task with no visible origin is one nobody
      // can audit: "why is Jarvis doing this" has to be answerable from the task.
      pool.query(
        `SELECT i.id, i.channel, i.sender, i.raw_text, i.received_at, i.route_category
         FROM inbox_events i JOIN tasks t ON t.origin_inbox_id = i.id
         WHERE t.id = $1`,
        [id],
      ),
    ]);

    return {
      task: r.rows[0],
      // Plan §41: active, elapsed, waiting and paused time.
      timing: await taskTiming(pool, id),
      transitions: transitions.rows,
      checkpoints: checkpoints.rows,
      events: events.rows,
      attempts: attempts.rows,
      grants: grants.rows,
      issues: issues.rows,
      approvals: approvals.rows,
      artifacts: artifacts.rows,
      origin: origin.rows[0] ?? null,
    };
  });

  /**
   * Add context to a task that is already running (plan S15, L17 journey 2).
   *
   * Until now the only way to say something to a run in flight was to talk in a
   * thread and hope the router attached it to the right task — which is the
   * right mechanism (S3c) and the wrong ergonomics on a phone, where you are
   * looking at the task and have to go and find its conversation.
   *
   * Deliberately the SAME table the router writes to, not a second channel: the
   * runner already delivers pending `task_context` into the worktree at its next
   * checkpoint boundary, so this inherits the delivery, the ordering and the
   * "context that was never delivered survives a crash" behaviour rather than
   * reimplementing them.
   */
  app.post("/api/tasks/:id/context", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const body = ((req.body ?? {}) as { body?: string }).body?.trim() ?? "";
    if (!body) return reply.code(400).send({ error: "body required" });

    const t = await pool.query<{ state: string; conversation_id: string | null }>(
      "SELECT state, conversation_id FROM tasks WHERE id = $1",
      [id],
    );
    const task = t.rows[0];
    if (!task) return reply.code(404).send({ error: "not found" });

    // A finished task cannot be told anything. Saying so is more useful than
    // storing a note nothing will ever read.
    if (["succeeded", "failed_terminal", "cancelled"].includes(task.state)) {
      return reply.code(409).send({
        error: {
          code: "task_finished",
          message: `this task is ${task.state}; context can only reach a run that is still going`,
        },
      });
    }

    const r = await pool.query<{ id: string }>(
      `INSERT INTO task_context (task_id, conversation_id, body, attached_state)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [id, task.conversation_id, body.slice(0, 4000), task.state],
    );
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('operator', 'task.context_added', $1, $2)`,
      [id, JSON.stringify({ context_id: r.rows[0].id, attached_state: task.state })],
    );
    sseBroadcast("task.updated", { id });
    return { context: { id: r.rows[0].id, attached_state: task.state } };
  });

  app.post("/api/tasks/:id/pause", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const cur = await pool.query<{ state: string }>(`SELECT state FROM tasks WHERE id = $1`, [id]);
    if (cur.rows[0]?.state !== "running") {
      return reply.code(409).send({ error: "only a running task can be paused" });
    }
    await transitionTask(pool, id, "paused", "paused from the console", "user");
    return { ok: true };
  });
  app.post("/api/tasks/:id/resume", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const cur = await pool.query<{ state: string }>(`SELECT state FROM tasks WHERE id = $1`, [id]);
    if (cur.rows[0]?.state !== "paused") {
      return reply.code(409).send({ error: "only a paused task can be resumed" });
    }
    await transitionTask(pool, id, "queued", "resumed from the console", "user");
    sseBroadcast("queue.updated", {});
    return { ok: true };
  });
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const cur = await pool.query<{ state: string }>(`SELECT state FROM tasks WHERE id = $1`, [id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: "not found" });
    if (["succeeded", "failed_terminal", "cancelled"].includes(cur.rows[0].state)) {
      return reply.code(409).send({ error: "task already finished" });
    }
    await transitionTask(pool, id, "cancelled", "cancelled from the console", "user", "cancel_requested_at = now()");
    /*
     * IV.9's "task cancelled". The transition table records the state change;
     * the audit trail records that a PERSON made it, which is the question
     * asked afterwards.
     */
    await audit(pool, {
      actor: "user",
      action: "task.cancel",
      target: id,
      taskId: id,
      outcome: "allowed",
      extra: { from_state: cur.rows[0].state },
    });
    return { ok: true };
  });
  app.post("/api/tasks/:id/reprioritize", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const priority = ((req.body ?? {}) as { priority?: string }).priority ?? "normal";
    await pool.query(`UPDATE tasks SET priority = $2, updated_at = now() WHERE id = $1`, [id, priority]);
    return { ok: true };
  });

  // Acceptance hooks. Operator session + origin required, same trust level as
  // the console, and each one only touches a probe task it just created. They
  // live under /api (not /internal) because /internal is the HMAC-only bridge
  // path and Caddy deliberately does not proxy it.
  app.post("/api/acceptance/task", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as {
      title?: string;
      lane?: string;
      state?: string;
      priority?: string;
    };
    const title = (b.title ?? "").trim();
    if (!title.startsWith("acceptance ")) {
      return reply.code(400).send({ error: "probe tasks must be titled 'acceptance …'" });
    }
    const lane = ["system", "heavy", "supervisor"].includes(b.lane ?? "") ? b.lane! : "system";
    const state = ["queued", "running"].includes(b.state ?? "") ? b.state! : "queued";
    const priority = ["critical", "high", "normal", "low", "background"].includes(b.priority ?? "")
      ? b.priority!
      : "low";
    const project = await pool.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug = 'jarvis-maintenance'`,
    );
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, priority, lane, heartbeat_at)
       VALUES ($1, $2, $2, $3, $4, $5, CASE WHEN $3 = 'running' THEN now() ELSE NULL END)
       RETURNING id`,
      [project.rows[0]?.id ?? null, title, state, priority, lane],
    );
    await pool.query(
      `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
       VALUES ($1, NULL, $2, 'acceptance probe created', 'acceptance')`,
      [r.rows[0].id, state],
    );
    return { task_id: r.rows[0].id };
  });

  app.post("/api/acceptance/action-request", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    // A throwaway issue + action request so the suite can exercise submit and
    // the used-link guard without touching a real blocker.
    const issue = await pool.query<{ id: string }>(
      `INSERT INTO issues (severity, category, service, status, owner, title, required_action, dedupe_key)
       VALUES ('low', 'setup.pending', 'acceptance', 'waiting_for_user', 'user',
               'acceptance probe action request', 'Submit the probe.', $1)
       RETURNING id`,
      [`acceptance.action.${Date.now()}`],
    );
    const { ensureActionRequest } = await import("./actions.js");
    const made = await ensureActionRequest(pool, {
      issueId: issue.rows[0].id,
      kind: "provide_config",
      title: "acceptance probe",
      message: "Probe created by the acceptance suite.",
      ttlHours: 1,
    });
    return { action_request_id: made.id, issue_id: issue.rows[0].id };
  });

  app.post("/api/acceptance/cleanup", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });

    // The suite creates real rows on the live box. Left behind they turn the
    // Issues page and the project list into a record of test runs, which hides
    // the things that actually need Enrique.
    const tasks = await pool.query(
      `UPDATE tasks SET state = 'cancelled', updated_at = now()
       WHERE title LIKE 'acceptance %'
         AND state NOT IN ('succeeded', 'failed_terminal', 'cancelled')
       RETURNING id`,
    );
    const projects = await pool.query(
      `UPDATE projects SET archived_at = now()
       WHERE archived_at IS NULL
         AND (slug LIKE 'proj-accept-%' OR slug LIKE 'validation-ok-%'
              OR slug LIKE 'enum-probe-%' OR slug LIKE 'type-probe-%'
              OR slug LIKE 'slug-guard-probe%')
       RETURNING id`,
    );
    const issues = await pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE status NOT IN ('resolved', 'ignored')
         AND (title ILIKE '%acceptance%'
              OR dedupe_key LIKE 'acceptance.%'
              OR dedupe_key LIKE 'upload.blocked:%'
              OR dedupe_key LIKE 'security.replay:%'
              OR dedupe_key LIKE 'routing.unassigned.%'
              OR dedupe_key LIKE 'sec.isolation:%some-other-projects-secret%'
              OR dedupe_key LIKE 'sec.isolation:%github_personal_admin'
              OR dedupe_key LIKE 'telnyx.unverified:%')
       RETURNING id`,
    );
    return {
      cancelled_tasks: tasks.rowCount ?? 0,
      archived_projects: projects.rowCount ?? 0,
      resolved_issues: issues.rowCount ?? 0,
    };
  });

  app.post("/api/acceptance/stall", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = ((req.body ?? {}) as { task_id?: string }).task_id;
    if (!id) return reply.code(400).send({ error: "task_id required" });
    // Only ever ages a probe task's heartbeat, never a real one.
    const r = await pool.query(
      `UPDATE tasks SET heartbeat_at = now() - interval '5 minutes'
       WHERE id = $1 AND title LIKE 'acceptance %' AND state IN ('running','preparing')
       RETURNING id`,
      [id],
    );
    if (!r.rows[0]) return reply.code(409).send({ error: "not an eligible probe task" });
    return { ok: true };
  });

  app.get("/api/queue", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query<{ id: string; state: string }>(
      `SELECT t.id, t.title, t.objective, t.state, t.priority, t.lane, t.model_role, t.harness,
              t.branch, t.waiting_reason, t.lease_owner, t.lease_until, t.heartbeat_at,
              t.created_at, t.updated_at,
              p.slug AS project_slug, p.name AS project_name
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.state <> 'captured'
         AND (t.state NOT IN ('succeeded','failed_terminal','cancelled')
              OR t.updated_at > now() - interval '24 hours')
         AND NOT (t.state = 'succeeded' AND ${ROUTINE_PREDICATE})
       ORDER BY
         CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
         t.created_at`,
    );

    // Grouped by what Enrique can act on, not by raw state names (Plan §41).
    const GROUPS: { key: string; label: string; states: string[] }[] = [
      { key: "running", label: "Running", states: ["running", "preparing", "waiting_for_tool"] },
      { key: "up_next", label: "Up Next", states: ["queued", "classified"] },
      { key: "blocked", label: "Blocked", states: ["stalled"] },
      { key: "waiting_for_user", label: "Waiting for User", states: ["waiting_for_user"] },
      { key: "waiting_for_approval", label: "Waiting for Approval", states: ["waiting_for_approval"] },
      { key: "waiting_for_provider", label: "Waiting for Provider", states: ["waiting_for_provider"] },
      { key: "recovering", label: "Recovering", states: ["recovering", "retry_scheduled"] },
      { key: "paused", label: "Paused", states: ["paused"] },
      { key: "recent", label: "Recently Completed", states: ["succeeded", "failed_terminal", "cancelled"] },
    ];
    const groups = GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      tasks: r.rows.filter((t) => g.states.includes(t.state)),
    }));

    const routine = await pool.query<{ name: string; runs: string; last_run: string | null }>(
      `SELECT sc.name, count(*)::text AS runs, max(sr.started_at) AS last_run
       FROM schedule_runs sr
       JOIN schedules sc ON sc.id = sr.schedule_id
       WHERE sc.priority = 'background' AND sr.started_at > now() - interval '24 hours'
       GROUP BY sc.name ORDER BY sc.name`,
    );
    return {
      queue: r.rows,
      groups,
      routine: routine.rows.map((x) => ({ name: x.name, runs: Number(x.runs), last_run: x.last_run })),
    };
  });

  app.get("/api/projects/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    // Accept slug or uuid: the console links by slug, the API returns uuids.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const r = await pool.query<{ id: string }>(
      isUuid ? `SELECT * FROM projects WHERE id = $1` : `SELECT * FROM projects WHERE slug = $1`,
      [id],
    );
    const project = r.rows[0];
    if (!project) return reply.code(404).send({ error: "not found" });

    const pid = project.id;
    const [tasks, conversations, issues, schedules, artifacts, memory, connections, activity] =
      await Promise.all([
        // Same rollup as the queue: a project's heartbeat ticks are not "work".
        pool.query(
          `SELECT t.id, t.title, t.objective, t.state, t.priority, t.lane, t.model_role, t.harness,
                  t.branch, t.created_at, t.updated_at
           FROM tasks t
           WHERE t.project_id = $1
             AND NOT (t.state = 'succeeded' AND ${ROUTINE_PREDICATE})
           ORDER BY t.created_at DESC LIMIT 50`,
          [pid],
        ),
        pool.query(
          `SELECT c.id, c.title, c.channel, c.created_at, c.last_activity_at,
                  (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count
           FROM conversations c WHERE c.project_id = $1 ORDER BY c.last_activity_at DESC LIMIT 50`,
          [pid],
        ),
        pool.query(
          `SELECT id, severity, category, status, title, service, created_at
           FROM issues WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [pid],
        ),
        pool.query(
          `SELECT s.id, s.name, s.cron, s.timezone, s.priority, s.paused, s.model_role,
                  (SELECT max(r.started_at) FROM schedule_runs r WHERE r.schedule_id = s.id) AS last_run_at
           FROM schedules s WHERE s.project_id = $1 ORDER BY s.name`,
          [pid],
        ),
        pool.query(
          `SELECT id, path, mime, bytes, source, quarantine_state, retention_class,
                  retain_until, permanent, created_at
           FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [pid],
        ),
        pool.query(
          `SELECT id, kind, body, created_at FROM memory_items
           WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [pid],
        ),
        pool.query(
          `SELECT c.slug, c.kind, c.scope, c.health, a.display_name, a.auth_type
           FROM connections c
           LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id
           WHERE c.project_id = $1 ORDER BY c.slug`,
          [pid],
        ),
        pool.query(
          `SELECT actor, action, target, at AS created_at, metadata
           FROM audit_events WHERE project_id = $1 ORDER BY at DESC LIMIT 50`,
          [pid],
        ),
      ]);

    // Every collection above is capped at 50 per project. jarvis-maintenance
    // already has 112 display-eligible tasks, so the tab badge and the "N tasks
    // recorded" stat were counting a page and calling it the project — and the
    // open-task count was taken from that same truncated slice, so it could miss
    // open work entirely. Counted in SQL instead, with the same predicates the
    // lists use so the totals mean what the labels say.
    const totalsQ = await pool.query<{
      tasks: string; open_tasks: string; issues: string; open_issues: string;
      conversations: string; artifacts: string; memory: string;
    }>(
      `SELECT
         (SELECT count(*) FROM tasks t
           WHERE t.project_id = $1
             AND NOT (t.state = 'succeeded' AND ${ROUTINE_PREDICATE}))::text AS tasks,
         (SELECT count(*) FROM tasks t
           WHERE t.project_id = $1
             AND t.state NOT IN ('succeeded','failed_terminal','cancelled'))::text AS open_tasks,
         (SELECT count(*) FROM issues WHERE project_id = $1)::text AS issues,
         (SELECT count(*) FROM issues
           WHERE project_id = $1 AND status NOT IN ('resolved','ignored'))::text AS open_issues,
         (SELECT count(*) FROM conversations WHERE project_id = $1)::text AS conversations,
         (SELECT count(*) FROM artifacts WHERE project_id = $1)::text AS artifacts,
         (SELECT count(*) FROM memory_items WHERE project_id = $1)::text AS memory`,
      [pid],
    );
    const tot = totalsQ.rows[0];

    return {
      project,
      tasks: tasks.rows,
      conversations: conversations.rows,
      issues: issues.rows,
      schedules: schedules.rows,
      artifacts: artifacts.rows,
      memory: memory.rows,
      connections: connections.rows,
      activity: activity.rows,
      totals: {
        tasks: Number(tot.tasks),
        open_tasks: Number(tot.open_tasks),
        issues: Number(tot.issues),
        open_issues: Number(tot.open_issues),
        conversations: Number(tot.conversations),
        artifacts: Number(tot.artifacts),
        memory: Number(tot.memory),
      },
    };
  });

  app.post("/api/projects", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as {
      name?: string;
      slug?: string;
      project_type?: string;
      confidentiality?: string;
      customer_facing?: boolean;
    };
    if (!b.name || !b.slug || !b.project_type) {
      return reply.code(400).send({ error: "name, slug, project_type required" });
    }
    // The slug becomes a filesystem path below, so it is validated before use.
    if (!validSlug(b.slug)) {
      return reply.code(400).send({
        error: "slug must be lowercase letters, numbers and hyphens, 3-50 characters",
      });
    }
    if (!validEnum("project_type", b.project_type)) {
      return reply.code(400).send({ error: "project_type must be personal or professional" });
    }
    if (b.confidentiality && !validEnum("confidentiality", b.confidentiality)) {
      return reply
        .code(400)
        .send({ error: "confidentiality must be normal, confidential or restricted" });
    }
    const r = await pool.query(
      `INSERT INTO projects (slug, name, is_system, project_type, confidentiality, customer_facing, metered_spend_allowed)
       VALUES ($1,$2,false,$3,$4,$5,false) RETURNING *`,
      [b.slug, b.name, b.project_type, b.confidentiality ?? "normal", Boolean(b.customer_facing)],
    );
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = WORKTREES_DIR;
    const worktree = path.resolve(root, b.slug);
    if (!worktree.startsWith(root + path.sep)) {
      return reply.code(400).send({ error: "invalid slug" });
    }
    await fs.mkdir(worktree, { recursive: true, mode: 0o750 });
    await fs.mkdir(path.join(ARTIFACTS_DIR, r.rows[0].id), { recursive: true, mode: 0o750 });
    await fs.mkdir(path.join(BROWSERS_DIR, r.rows[0].id), { recursive: true, mode: 0o750 });
    return { project: r.rows[0] };
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { name?: string; archived?: boolean };
    if (b.name) {
      await pool.query(`UPDATE projects SET name = $2 WHERE id = $1`, [id, b.name]);
    }
    if (b.archived) {
      await pool.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [id]);
    }
    const r = await pool.query(`SELECT * FROM projects WHERE id = $1`, [id]);
    return { project: r.rows[0] };
  });

  app.get("/api/issues", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT i.id, i.severity, i.category, i.status, i.owner, i.title, i.service,
              i.evidence, i.required_action, i.dedupe_key, i.suppress_reason,
              i.occurrences, i.last_seen_at, i.created_at, i.updated_at, i.resolved_at,
              p.slug AS project_slug, p.name AS project_name,
              t.title AS task_title, i.task_id
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN tasks t ON t.id = i.task_id
       ORDER BY
         CASE i.status WHEN 'resolved' THEN 1 WHEN 'ignored' THEN 1 ELSE 0 END,
         CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         i.last_seen_at DESC
       LIMIT 200`,
    );
    // Counted in SQL, not by filtering the page above. There are already more
    // issues than the cap, and the ordering puts resolved ones last, so a
    // client-side "handled by Jarvis" tally silently undercounts by exactly the
    // rows that fell off the end — the count decays as Jarvis handles more.
    const t = await pool.query<{
      all: string; open: string; critical: string; waiting_user: string;
      handled: string; suppressed: string;
    }>(
      `SELECT count(*)::text AS all,
              count(*) FILTER (WHERE status NOT IN ('resolved','ignored'))::text AS open,
              count(*) FILTER (WHERE severity = 'critical'
                                 AND status NOT IN ('resolved','ignored'))::text AS critical,
              count(*) FILTER (WHERE status = 'waiting_for_user')::text AS waiting_user,
              count(*) FILTER (WHERE status = 'resolved' AND owner = 'jarvis')::text AS handled,
              count(*) FILTER (WHERE status = 'ignored')::text AS suppressed
       FROM issues`,
    );
    const row = t.rows[0];
    return {
      issues: r.rows,
      totals: {
        all: Number(row.all),
        open: Number(row.open),
        critical: Number(row.critical),
        waiting_user: Number(row.waiting_user),
        handled: Number(row.handled),
        suppressed: Number(row.suppressed),
      },
    };
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `SELECT i.*, p.slug AS project_slug, p.name AS project_name, t.title AS task_title
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN tasks t ON t.id = i.task_id
       WHERE i.id = $1`,
      [id],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not found" });
    const events = await pool.query(
      `SELECT id, at, body, actor FROM issue_events WHERE issue_id = $1 ORDER BY at`,
      [id],
    );
    return { issue: r.rows[0], events: events.rows };
  });

  const ISSUE_STATUSES = [
    "open",
    "investigating",
    "auto_resolving",
    "waiting_for_jarvis",
    "waiting_for_user",
    "waiting_for_provider",
    "resolved",
  ];

  app.post("/api/issues/:id/status", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { status?: string; note?: string };
    if (!b.status || !ISSUE_STATUSES.includes(b.status)) {
      return reply.code(400).send({ error: `status must be one of ${ISSUE_STATUSES.join(", ")}` });
    }
    const r = await pool.query(
      `UPDATE issues
       SET status = $2,
           resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [id, b.status],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not found" });
    await pool.query(
      `INSERT INTO issue_events (issue_id, body, actor) VALUES ($1, $2, 'user')`,
      [id, b.note?.trim() || `status set to ${b.status}`],
    );
    sseBroadcast("issue.updated", { id });
    return { ok: true };
  });

  app.post("/api/issues/:id/note", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const body = ((req.body ?? {}) as { body?: string }).body?.trim();
    if (!body) return reply.code(400).send({ error: "body required" });
    await pool.query(
      `INSERT INTO issue_events (issue_id, body, actor) VALUES ($1, $2, 'user')`,
      [id, body],
    );
    await pool.query(`UPDATE issues SET updated_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  app.post("/api/issues/:id/ignore", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? "ignored";
    await pool.query(
      `UPDATE issues SET status = 'ignored', suppress_reason = $2, resolved_at = now(), updated_at = now() WHERE id = $1`,
      [id, reason],
    );
    sseBroadcast("issue.updated", { id });
    return { ok: true };
  });

  app.get("/api/approvals", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT a.id, a.action_type, a.target, a.environment, a.resource_version, a.state,
              a.expires_at, a.decided_at, a.task_id, a.binding_sha, a.requires_reauth,
              p.slug AS project_slug, p.name AS project_name,
              t.title AS task_title
       FROM approvals a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN tasks t ON t.id = a.task_id
       ORDER BY
         CASE a.state WHEN 'pending' THEN 0 ELSE 1 END,
         COALESCE(a.decided_at, a.expires_at) DESC NULLS LAST
       LIMIT 100`,
    );
    return { approvals: r.rows };
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { approved?: boolean; decision?: string };
    // The console sends decision: "approve" | "reject"; keep the boolean form too.
    const approved =
      typeof b.approved === "boolean" ? b.approved : b.decision === "approve";

    const pending = await pool.query<{
      action_type: string; target: string | null; project_id: string | null;
      environment: string | null; resource_version: string | null; binding_sha: string | null;
    }>(
      `SELECT action_type, target, project_id, environment, resource_version, binding_sha
       FROM approvals WHERE id = $1 AND state = 'pending'`,
      [id],
    );
    const ask = pending.rows[0];
    if (!ask) return reply.code(409).send({ error: "not pending" });

    const level3 = isAlwaysConfirm(ask.action_type);
    const token = req.cookies["jarvis_session"] ?? "";
    const session = token ? sessionKey(token) : "";

    /*
     * Level 3 asks for the password again (Part V).
     *
     * Rejecting never does: refusing something dangerous must never be the
     * harder path, or the safe action is the one that gets skipped.
     */
    if (approved && level3) {
      if (!session || !(await reauthFresh(pool, session))) {
        await pool.query(
          `INSERT INTO audit_events (actor, action, target, project_id, metadata)
           VALUES ('user', 'approval.approve', $1, $2, $3)`,
          [ask.target ?? ask.action_type, ask.project_id,
            JSON.stringify({
              approval_id: id, action_type: ask.action_type, level: "3",
              outcome: "denied", reason: "no recent re-authentication",
            })],
        );
        return reply.code(403).send({
          error: "reauth_required",
          message: "This is an always-confirm action. Enter your password to approve it.",
        });
      }

      const used = await level3ThisHour(pool, session);
      if (used >= LEVEL3_HOURLY_CEILING) {
        await pool.query(
          `INSERT INTO audit_events (actor, action, target, project_id, metadata)
           VALUES ('user', 'approval.approve', $1, $2, $3)`,
          [ask.target ?? ask.action_type, ask.project_id,
            JSON.stringify({
              approval_id: id, action_type: ask.action_type, level: "3",
              outcome: "denied", reason: `hourly ceiling of ${LEVEL3_HOURLY_CEILING} reached`,
            })],
        );
        return reply.code(429).send({
          error: "ceiling_reached",
          message: `That is ${LEVEL3_HOURLY_CEILING} always-confirm approvals in an hour. Nothing was applied.`,
        });
      }
    }

    /*
     * And it binds to what it approved.
     *
     * "If the page has moved on, the click is refused and re-presented rather
     * than applied to whatever is current now." The console sends back the hash
     * it rendered; if the approval has been rewritten since, the two differ.
     */
    const expected = bindingSha({
      actionType: ask.action_type,
      target: ask.target,
      environment: ask.environment,
      resourceVersion: ask.resource_version,
      projectId: ask.project_id,
    });
    const claimed = (b as { binding_sha?: string }).binding_sha;
    if (approved && ask.binding_sha && ask.binding_sha !== expected) {
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, project_id, metadata)
         VALUES ('user', 'approval.approve', $1, $2, $3)`,
        [ask.target ?? ask.action_type, ask.project_id,
          JSON.stringify({
            approval_id: id, action_type: ask.action_type,
            outcome: "denied", reason: "the request changed after it was presented",
          })],
      );
      return reply.code(409).send({
        error: "stale",
        message: "This request changed after it was shown to you. Look at it again.",
      });
    }
    if (approved && claimed && claimed !== expected) {
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, project_id, metadata)
         VALUES ('user', 'approval.approve', $1, $2, $3)`,
        [ask.target ?? ask.action_type, ask.project_id,
          JSON.stringify({
            approval_id: id, action_type: ask.action_type,
            outcome: "denied", reason: "approved against a stale screen",
          })],
      );
      return reply.code(409).send({
        error: "stale",
        message: "The screen you approved from is out of date. Look at it again.",
      });
    }

    const r = await pool.query<{ action_type: string; target: string | null; project_id: string | null }>(
      `UPDATE approvals SET state = $2, decided_at = now()
       WHERE id = $1 AND state = 'pending'
       RETURNING action_type, target, project_id`,
      [id, approved ? "approved" : "rejected"],
    );
    if (!r.rows[0]) return reply.code(409).send({ error: "not pending" });
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('user', $1, $2, $3, $4)`,
      [
        approved ? "approval.approve" : "approval.reject",
        r.rows[0].target ?? r.rows[0].action_type,
        r.rows[0].project_id,
        JSON.stringify({
          approval_id: id,
          action_type: r.rows[0].action_type,
          level: level3 ? "3" : "1",
          session,
          outcome: "allowed",
        }),
      ],
    );
    sseBroadcast("approval.updated", { id });
    return { ok: true, state: approved ? "approved" : "rejected" };
  });

  // Action requests moved to src/actions.ts (one-time tokens, real state).

  app.get("/api/schedules", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query<{
      id: string;
      cron: string;
      timezone: string;
      paused: boolean;
    }>(
      `SELECT s.*, p.slug AS project_slug, p.name AS project_name,
              (SELECT max(sr.started_at) FROM schedule_runs sr WHERE sr.schedule_id = s.id) AS last_run_at,
              (SELECT count(*) FROM schedule_runs sr
                WHERE sr.schedule_id = s.id AND sr.started_at > now() - interval '7 days')::int
                AS runs_7d,
              (SELECT t.state FROM schedule_runs sr
                JOIN tasks t ON t.id = sr.task_id
                WHERE sr.schedule_id = s.id
                ORDER BY sr.started_at DESC LIMIT 1) AS last_state
       FROM schedules s
       JOIN projects p ON p.id = s.project_id
       ORDER BY p.name, s.name`,
    );
    const now = new Date();
    const schedules = r.rows.map((row) => ({
      ...row,
      next_run_at: row.paused
        ? null
        : (cronNextRun(row.cron, now, row.timezone || "America/New_York")?.toISOString() ?? null),
    }));
    return { schedules };
  });

  app.get("/api/schedules/:id/runs", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `SELECT sr.id, sr.scheduled_for, sr.started_at, sr.result, t.state AS task_state, t.id AS task_id
       FROM schedule_runs sr
       LEFT JOIN tasks t ON t.id = sr.task_id
       WHERE sr.schedule_id = $1
       ORDER BY sr.started_at DESC LIMIT 50`,
      [id],
    );
    return { runs: r.rows };
  });

  app.put("/api/schedules/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { paused?: boolean; cron?: string };
    const before = await pool.query<{ paused: boolean; cron: string; name: string; project_id: string }>(
      `SELECT paused, cron, name, project_id FROM schedules WHERE id = $1`,
      [id],
    );
    if (!before.rows[0]) return reply.code(404).send({ error: "not found" });
    if (typeof b.paused === "boolean") {
      await pool.query(`UPDATE schedules SET paused = $2 WHERE id = $1`, [id, b.paused]);
    }
    if (b.cron) {
      await pool.query(`UPDATE schedules SET cron = $2 WHERE id = $1`, [id, b.cron]);
    }
    const r = await pool.query(`SELECT * FROM schedules WHERE id = $1`, [id]);

    // Config changes are versioned (plan §: config_versions). The table existed
    // and nothing wrote to it, so schedule edits left no trace beyond the audit line.
    if (typeof b.paused === "boolean" || b.cron) {
      await pool.query(
        `INSERT INTO config_versions (scope, project_id, key, value, version, actor, note)
         VALUES ('project', $1, $2, $3,
                 COALESCE((SELECT max(version) FROM config_versions WHERE key = $2), 0) + 1,
                 'user', $4)`,
        [
          before.rows[0].project_id,
          `schedule:${before.rows[0].name}`,
          JSON.stringify({
            from: { paused: before.rows[0].paused, cron: before.rows[0].cron },
            to: { paused: r.rows[0].paused, cron: r.rows[0].cron },
          }),
          b.cron ? "cron changed" : b.paused ? "paused" : "resumed",
        ],
      );
      await audit(pool, {
        actor: "user",
        action: "schedule.update",
        target: before.rows[0].name,
        projectId: before.rows[0].project_id,
        outcome: "allowed",
        extra: { paused: r.rows[0].paused, cron: r.rows[0].cron },
      });
    }
    return { schedule: r.rows[0] };
  });

  app.get("/api/audit", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const q = req.query as { project_id?: string; from?: string; action?: string };
    // `action` is a prefix filter. Without it the only way to ask "when did the
    // last restore drill run?" is to scan the newest 200 events and hope it is
    // still among them — which stopped being true as soon as the audit log grew,
    // turning a verified backup into "no restore drill has ever run".
    const r = await pool.query(
      `SELECT e.id, e.at, e.at AS created_at, e.actor, e.action, e.project_id, e.target, e.metadata,
              p.slug AS project_slug, p.name AS project_name
       FROM audit_events e
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE ($1::uuid IS NULL OR e.project_id = $1)
         AND ($2::timestamptz IS NULL OR e.at >= $2)
         AND ($3::text IS NULL OR e.action LIKE $3 || '%')
       ORDER BY e.at DESC LIMIT 200`,
      [q.project_id ?? null, q.from ?? null, q.action ?? null],
    );
    // `events` is the name every other list endpoint uses and what the console
    // reads; `audit` is kept so nothing already pointed at it breaks.
    return { events: r.rows, audit: r.rows };
  });

  app.get("/api/config-versions", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(`SELECT * FROM config_versions ORDER BY at DESC LIMIT 50`);
    return { config_versions: r.rows };
  });

  app.get("/api/artifacts", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    /*
     * Paginated (S17: "fifty artifacts on one project -> the page paginates
     * rather than dying"). It used to return the newest 200 with no way to ask
     * for the next page, so an artifact older than the two hundredth was
     * unreachable through the console at all.
     */
    const q = req.query as { limit?: string; offset?: string; project_id?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const projectFilter = q.project_id ?? null;
    const r = await pool.query(
      `SELECT a.id, a.project_id, a.path, a.mime, a.bytes, a.source, a.quarantine_state,
              a.retention_class, a.retain_until, a.permanent, a.sha256, a.created_at,
              a.artifact_type, a.state, a.version, a.supersedes_id, a.reviewer_notes,
              a.reviewed_at, a.delivered_at, a.external_url, a.task_id,
              a.created_by_agent, a.created_by_model, a.created_by_harness,
              a.created_by_auth_profile,
              p.slug AS project_slug, p.name AS project_name
       FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id
       WHERE ($1::uuid IS NULL OR a.project_id = $1)
       ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      [projectFilter, limit, offset],
    );
    const t = await pool.query<{
      all: string; quarantined: string; due_soon: string; bytes: string;
    }>(
      // `due_soon` is three days, matching what the Artifacts page has always
      // meant by it. A total that counts a different window than the label
      // promises is worse than no total.
      `SELECT count(*)::text AS all,
              count(*) FILTER (WHERE quarantine_state <> 'clean')::text AS quarantined,
              count(*) FILTER (WHERE NOT permanent AND retain_until IS NOT NULL
                                 AND retain_until < now() + interval '3 days')::text AS due_soon,
              coalesce(sum(bytes), 0)::text AS bytes
       FROM artifacts`,
    );
    const row = t.rows[0];
    return {
      artifacts: r.rows,
      totals: {
        all: Number(row.all),
        quarantined: Number(row.quarantined),
        due_soon: Number(row.due_soon),
        bytes: Number(row.bytes),
      },
    };
  });

  app.get("/api/operations/quiet-hours", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const tz = "America/New_York";
    return {
      quiet_hours: inQuietHours(new Date(), tz),
      timezone: tz,
      window: "19:30-08:00",
      note: "Outbound calls are held during quiet hours; WhatsApp and the console are used instead.",
    };
  });

  app.get("/api/health-incidents", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT id, service, severity, opened_at, closed_at, summary
       FROM health_incidents ORDER BY opened_at DESC LIMIT 100`,
    );
    return {
      incidents: r.rows,
      open: r.rows.filter((i: { closed_at: Date | null }) => !i.closed_at).length,
    };
  });

  app.get("/api/notifications", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT id, channel, message_type, body, state, attempts, created_at, last_error
       FROM notifications_outbox ORDER BY created_at DESC LIMIT 100`,
    );
    return { notifications: r.rows };
  });

  app.get("/api/memory", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const q = ((req.query as { q?: string }).q ?? "").trim();
    const r = await pool.query(
      `SELECT id, project_id, kind, body, created_at FROM memory_items
       WHERE ($1 = '' OR body ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT 50`,
      [q],
    );
    return { memory: r.rows };
  });

  app.get("/api/artifacts/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{
      id: string;
      path: string;
      mime: string | null;
      bytes: string | null;
      quarantine_state: string;
      project_id: string | null;
    }>(`SELECT * FROM artifacts WHERE id = $1`, [id]);
    const artifact = r.rows[0];
    if (!artifact) return reply.code(404).send({ error: "not found" });

    // Metadata by default; ?download=1 streams the bytes.
    if ((req.query as { download?: string }).download !== "1") {
      return { artifact };
    }

    // An artifact that has not passed the scan is never served, to a model or
    // to the browser (plan §: quarantine gate).
    if (artifact.quarantine_state !== "clean") {
      return reply.code(409).send({
        error: {
          code: "artifact_quarantined",
          message: `artifact is ${artifact.quarantine_state}; it is not served until the scan clears it`,
        },
      });
    }

    const fs = await import("node:fs");
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");

    // artifacts.path is data, so it is contained before it reaches the disk.
    const root = ARTIFACTS_DIR;
    const full = path.resolve(root, artifact.path);
    if (!full.startsWith(root + path.sep)) {
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, project_id, metadata)
         VALUES ('user', 'security.isolation', $1, $2, $3)`,
        [artifact.id, artifact.project_id, JSON.stringify({ reason: "artifact path escaped its root" })],
      );
      return reply.code(400).send({ error: { code: "bad_path", message: "invalid artifact path" } });
    }
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat || !stat.isFile()) {
      return reply.code(404).send({ error: { code: "not_found", message: "artifact bytes are gone" } });
    }

    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('user', 'artifact.download', $1, $2, $3)`,
      [artifact.id, artifact.project_id, JSON.stringify({ bytes: stat.size })],
    );

    // Always an attachment, never inline: artifact content is untrusted and the
    // console shares this origin with the session cookie, so rendering an
    // attacker-supplied HTML artifact here would be same-origin script execution.
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(stat.size))
      .header("Content-Disposition", `attachment; filename="${path.basename(full).replace(/"/g, "")}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.send(fs.createReadStream(full));
  });

  app.post("/api/connections/:id/test", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const conn = await pool.query<{ slug: string; auth_profile_id: string | null; credential_id: string | null }>(
      `SELECT c.slug, c.auth_profile_id, COALESCE(c.credential_id, a.credential_id) AS credential_id
       FROM connections c
       LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id
       WHERE c.slug = $1 OR c.id::text = $1`,
      [id],
    );
    const c = conn.rows[0];
    if (!c) return reply.code(404).send({ error: "not found" });
    let ok = false;
    if (c.slug === "groq" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${cred.api_key}` },
      });
      ok = res.ok;
    } else if (c.slug === "github_personal_admin" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${cred.api_key}`, "User-Agent": "jarvis-core" },
      });
      ok = res.ok;
    } else if (c.slug === "elevenlabs" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": cred.api_key },
      });
      ok = res.ok;
    } else if (c.slug === "google_ai" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cred.api_key)}`,
      );
      ok = res.ok;
    } else if (c.slug === "nvidia" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: { Authorization: `Bearer ${cred.api_key}` },
      });
      ok = res.ok;
    } else if (c.slug === "composio" && c.credential_id) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://backend.composio.dev/api/v1/apps", {
        headers: { "x-api-key": cred.api_key },
      });
      ok = res.ok;
    } else if (c.slug === "backup_b2") {
      ok = true;
    } else {
      ok = Boolean(c.credential_id);
    }
    await pool.query(`UPDATE connections SET health = $2, last_tested_at = now() WHERE slug = $1`, [
      c.slug,
      ok ? "healthy" : "degraded",
    ]);
    return { ok, slug: c.slug };
  });

  app.get("/api/channel-allowlist", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(`SELECT * FROM channel_allowlist ORDER BY channel, identifier`);
    return { allowlist: r.rows };
  });

  app.post("/api/channel-allowlist", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as {
      channel?: string;
      identifier?: string;
      display?: string;
      can_command?: boolean;
    };
    if (!b.channel || !b.identifier) return reply.code(400).send({ error: "channel and identifier required" });
    const r = await pool.query(
      `INSERT INTO channel_allowlist (channel, identifier, display, can_command)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel, identifier) DO UPDATE SET display = EXCLUDED.display, can_command = EXCLUDED.can_command
       RETURNING *`,
      [b.channel, b.identifier, b.display ?? null, Boolean(b.can_command)],
    );
    return { entry: r.rows[0] };
  });

  app.get("/api/github/me", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const row = await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM auth_profiles WHERE id = 'github_personal_admin' AND credential_id IS NOT NULL",
    );
    if (!row.rows[0]) return reply.code(404).send({ error: "github_personal_admin missing" });
    const cred = await readJsonCredential(pool, row.rows[0].credential_id);
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${cred.api_key}`, "User-Agent": "jarvis-core" },
    });
    if (!res.ok) return reply.code(502).send({ error: `github ${res.status}` });
    const json = (await res.json()) as { login?: string; id?: number };
    return { login: json.login, id: json.id };
  });

  app.post("/api/github/admin/create-repo", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const name = ((req.body ?? {}) as { name?: string }).name;
    if (!name) return reply.code(400).send({ error: "name required" });
    const result = await githubCreatePrivateRepo(pool, name);
    if ("error" in result) return reply.code(502).send(result);
    return result;
  });

  app.post("/api/projects/:id/deploy-key", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const projectId = (req.params as { id: string }).id;
    const proj = await pool.query<{ id: string; slug: string; github_owner: string | null; github_repo: string | null }>(
      `SELECT id, slug, github_owner, github_repo FROM projects WHERE id = $1 OR slug = $1`,
      [projectId],
    );
    const p = proj.rows[0];
    if (!p) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { owner?: string; repo?: string };
    const owner = b.owner || p.github_owner;
    const repo = b.repo || p.github_repo;
    if (!owner || !repo) return reply.code(400).send({ error: "owner and repo required" });
    const result = await githubProvisionDeployKey(pool, p.id, owner, repo);
    if ("error" in result) return reply.code(502).send(result);
    return result;
  });

  app.post("/api/projects/:id/pull-requests", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const projectId = (req.params as { id: string }).id;
    const proj = await pool.query<{ github_owner: string | null; github_repo: string | null; default_branch: string | null }>(
      `SELECT github_owner, github_repo, default_branch FROM projects WHERE id = $1 OR slug = $1`,
      [projectId],
    );
    const p = proj.rows[0];
    if (!p || !p.github_owner || !p.github_repo) return reply.code(400).send({ error: "project has no linked GitHub repo" });
    const b = (req.body ?? {}) as { title?: string; head?: string; base?: string; body?: string };
    if (!b.title || !b.head) return reply.code(400).send({ error: "title and head branch required" });
    const result = await githubCreatePullRequest(pool, {
      owner: p.github_owner,
      repo: p.github_repo,
      title: b.title,
      head: b.head,
      base: b.base || p.default_branch || "main",
      body: b.body,
    });
    if ("error" in result) return reply.code(502).send(result);
    return result;
  });

  app.post("/api/projects/:id/pull-requests/:number/merge", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const projectId = (req.params as { id: string }).id;
    const pullNumber = Number((req.params as { number: string }).number);
    const proj = await pool.query<{ id: string; github_owner: string | null; github_repo: string | null }>(
      `SELECT id, github_owner, github_repo FROM projects WHERE id = $1 OR slug = $1`,
      [projectId],
    );
    const p = proj.rows[0];
    if (!p || !p.github_owner || !p.github_repo) return reply.code(400).send({ error: "project has no linked GitHub repo" });
    const b = (req.body ?? {}) as { sha?: string; task_id?: string; grant_id?: string };

    // If grant_id is provided, verify it binds to this project and commit sha
    if (b.grant_id) {
      const g = await pool.query<{ project_id: string; allowed_sha: string | null; expires_at: Date | null; invalidated_at: Date | null }>(
        `SELECT project_id, allowed_sha, expires_at, invalidated_at FROM task_grants WHERE id = $1`,
        [b.grant_id],
      );
      const grant = g.rows[0];
      if (!grant || grant.project_id !== p.id || grant.invalidated_at) {
        return reply.code(403).send({ error: { code: "broker_deny", message: "Grant invalid or invalidated" } });
      }
      if (grant.expires_at && grant.expires_at.getTime() < Date.now()) {
        return reply.code(403).send({ error: { code: "broker_deny", message: "Grant expired" } });
      }
      if (grant.allowed_sha && b.sha && grant.allowed_sha !== b.sha) {
        return reply.code(403).send({ error: { code: "broker_deny", message: "SHA mismatch against bound grant" } });
      }
    }

    const result = await githubMergePullRequest(pool, {
      owner: p.github_owner,
      repo: p.github_repo,
      pull_number: pullNumber,
      sha: b.sha,
    });
    if ("error" in result) return reply.code(502).send(result);
    await audit(pool, {
      actor: "broker",
      action: "github.merge_pull_request",
      target: `${p.github_owner}/${p.github_repo}#${pullNumber}`,
      projectId: p.id,
      outcome: "allowed",
      tool: "github.merge",
      extra: { sha: b.sha, grant_id: b.grant_id ?? null, task_id: b.task_id ?? null },
    });
    return result;
  });

  app.get("/api/events", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseAdd(reply);
    reply.raw.write(`event: health\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  });

  app.post("/internal/inbox/ingest", async (req, reply) => {
    if (!verifyInternalHmac(req, requestRawBody(req))) return reply.code(401).send({ error: "hmac" });
    // S18b: a retried post must not create a second row.
    const idem = await internalIdempotency(pool, req, "inbox.ingest");
    if (idem.replay) return { ok: true, replay: true };
    const b = (req.body ?? {}) as {
      channel?: string;
      external_id?: string;
      sender?: string;
      text?: string;
    };
    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
    );
    const conversationId = conv.rows[0]?.id;
    if (!conversationId) return reply.code(500).send({ error: "no global conversation" });
    const text = b.text ?? "";
    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events (external_id, channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
       VALUES ($1,$2,$3,$4,$5,'persisted','pending',$6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [b.external_id ?? null, b.channel ?? "whatsapp", b.sender ?? "", text, checksum(text), conversationId],
    );
    if (!inbox.rows[0]) return { ok: true, deduped: true };
    const result = await ingestUserMessage(pool, {
      conversationId,
      body: text,
      inboxId: inbox.rows[0].id,
    });
    return { ok: true, inbox_id: result.inboxId };
  });

  app.post("/internal/schedules/fire", async (req, reply) => {
    if (!verifyInternalHmac(req, requestRawBody(req))) return reply.code(401).send({ error: "hmac" });
    // S18b: a retried post must not create a second row.
    const idem = await internalIdempotency(pool, req, "schedules.fire");
    if (idem.replay) return { ok: true, replay: true };
    const b = (req.body ?? {}) as { schedule_id?: string; scheduled_for?: string };
    const sched = await pool.query<{ id: string; name: string; project_id: string; paused: boolean }>(
      "SELECT id, name, project_id, paused FROM schedules WHERE id = $1",
      [b.schedule_id],
    );
    if (!sched.rows[0] || sched.rows[0].paused) return { ok: true, skipped: true };
    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, priority, lane)
       VALUES ($1, $2, $2, 'queued', 'background', 'system') RETURNING id`,
      [sched.rows[0].project_id, sched.rows[0].name],
    );
    await pool.query(
      `INSERT INTO schedule_runs (schedule_id, task_id, scheduled_for, started_at)
       VALUES ($1, $2, $3, now())`,
      [sched.rows[0].id, task.rows[0].id, b.scheduled_for ?? new Date().toISOString()],
    );
    sseBroadcast("queue.updated", {});
    return { ok: true, task_id: task.rows[0].id };
  });

  // The restore drill reports here over the HMAC-only internal path. A backup
  // nobody has restored is not a backup, so the outcome is recorded where the
  // console can see it rather than living in a log file on the box.
  app.post("/internal/maintenance/restore-drill", async (req, reply) => {
    if (!verifyInternalHmac(req, requestRawBody(req))) return reply.code(401).send({ error: "hmac" });
    const b = (req.body ?? {}) as {
      ok?: boolean;
      snapshot?: string;
      dump_bytes?: number;
      checks?: Record<string, number>;
      canary_decrypted?: boolean;
      detail?: string;
    };
    const ok = Boolean(b.ok);
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('maintenance', $1, $2, $3)`,
      [
        ok ? "backup.restore_drill.pass" : "backup.restore_drill.fail",
        b.snapshot ?? "latest",
        JSON.stringify({
          dump_bytes: b.dump_bytes ?? 0,
          canary_decrypted: Boolean(b.canary_decrypted),
          checks: b.checks ?? {},
          detail: b.detail ?? "",
        }),
      ],
    );

    if (ok) {
      await pool.query(
        `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE dedupe_key = 'backup.restore_drill' AND status NOT IN ('resolved','ignored')`,
      );
      await pool.query(
        `UPDATE connections SET health = 'healthy', last_tested_at = now() WHERE slug = 'backup_b2'`,
      );
    } else {
      await raiseIssue(pool, {
        category: "backup.failure",
        service: "backup",
        title: "[backup] restore drill failed — the backup may not be restorable",
        dedupeKey: "backup.restore_drill",
        evidence: { detail: b.detail ?? "", snapshot: b.snapshot ?? "latest" },
        requiredAction:
          "Run jarvis-restore-drill on the VPS and read the failing check. Do not trust the backups until this passes.",
      });
      await pool.query(
        `UPDATE connections SET health = 'degraded', last_tested_at = now() WHERE slug = 'backup_b2'`,
      );
    }
    sseBroadcast("issue.updated", {});
    return { ok: true, recorded: ok ? "pass" : "fail" };
  });

  app.post("/internal/workers/heartbeat", async (req, reply) => {
    if (!verifyInternalHmac(req, requestRawBody(req))) return reply.code(401).send({ error: "hmac" });
    const b = (req.body ?? {}) as {
      task_id?: string;
      worker_id?: string;
      phase?: string;
      cpu_busy?: boolean;
      last_tool?: string;
      progress_note?: string;
    };
    if (!b.task_id) return { ok: true, cancel_requested: false };

    // WORKERS.md: the heartbeat carries live status, and it is how a worker
    // learns it has been cancelled — the API sets the flag, the worker checks
    // it each beat. Without returning it, Cancel only changed a row.
    const r = await pool.query<{ cancel_requested_at: Date | null }>(
      `UPDATE tasks
       SET heartbeat_at = now(),
           lease_until = now() + interval '60 seconds',
           phase = COALESCE($2, phase),
           last_tool = COALESCE($3, last_tool),
           progress_note = COALESCE($4, progress_note),
           updated_at = now()
       WHERE id = $1
       RETURNING cancel_requested_at`,
      [b.task_id, b.phase ?? null, b.last_tool ?? null, b.progress_note ?? null],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "unknown task" });
    sseBroadcast("task.updated", { id: b.task_id, phase: b.phase });
    return { ok: true, cancel_requested: Boolean(r.rows[0].cancel_requested_at) };
  });

  /**
   * Rendered call audio, fetched by Telnyx during a call.
   *
   * Unauthenticated by necessity — Telnyx is fetching it, not a logged-in
   * browser — so the token is the whole control: a 32-hex name derived from the
   * voice and the greeting text, never from anything a caller supplies. The
   * pattern is enforced before touching the filesystem, and the resolved path
   * must still sit inside the audio directory, so no traversal is expressible.
   */
  app.get("/api/audio/:file", async (req, reply) => {
    // u-law WAV for calls; mp3 kept so older cached renders still play.
    const file = String((req.params as { file: string }).file ?? "");
    if (!/^[a-f0-9]{32}\.(wav|mp3)$/.test(file)) {
      return reply.code(404).send({ error: "not found" });
    }
    const dir = audioDir();
    const full = path.resolve(dir, file);
    if (!full.startsWith(path.resolve(dir) + path.sep)) {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      const bytes = await fsp.readFile(full);
      return reply
        .header("Content-Type", file.endsWith(".wav") ? "audio/wav" : "audio/mpeg")
        .header("Cache-Control", "public, max-age=3600")
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  /**
   * Tier 1 of the call agent: what to say back, immediately.
   *
   * Returns in well under a second because it is tool-less by design. When it
   * delegates, the caller hears the acknowledgement while the desk works — the
   * client then calls /api/call/desk for the real answer. Splitting the two is
   * what lets a browser or a phone line fill the gap with sound instead of
   * silence.
   */
  app.post("/api/call/turn", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const said = String((req.body as { text?: string })?.text ?? "").trim();
    if (!said) return reply.code(400).send({ error: "text required" });

    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
    );
    const conversationId = conv.rows[0]?.id ?? null;

    // Persist-first: what was said is recorded before any model sees it.
    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events
         (channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
       VALUES ('voice', 'enrique', $1, $2, 'persisted', 'pending', $3)
       RETURNING id`,
      [said.slice(0, 8000), checksum(said), conversationId],
    );

    const t0 = Date.now();
    const verdict = await triage(pool, said);
    const tTriage = Date.now();
    const audio = await renderSpeech(pool, verdict.say).catch(() => null);
    return {
      mode: verdict.mode,
      say: verdict.say,
      audio_url: audio,
      // Split so a slow turn can be attributed rather than guessed at: a fresh
      // phrase pays ElevenLabs, a repeated one is served from cache.
      timing: { triage_ms: tTriage - t0, tts_ms: Date.now() - tTriage },
      inbox_id: inbox.rows[0].id,
      conversation_id: conversationId,
    };
  });

  /** Tier 2: the full Supervisor, with every tool. No latency budget. */
  app.post("/api/call/desk", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as { text?: string; inbox_id?: string; conversation_id?: string };
    const request = String(b.text ?? "").trim();
    if (!request || !b.inbox_id || !b.conversation_id) {
      return reply.code(400).send({ error: "text, inbox_id and conversation_id required" });
    }
    const answer = await delegateToDesk(pool, {
      conversationId: b.conversation_id,
      inboxId: b.inbox_id,
      request,
    }).catch(() => null);
    const spoken = answer ?? "The desk could not reach a model just then, sir. Your request is saved.";
    const audio = await renderSpeech(pool, spoken).catch(() => null);
    return { say: spoken, audio_url: audio, ok: Boolean(answer) };
  });

  app.post("/webhooks/telnyx", async (req, reply) => {
    // ADR 009: this is the only public endpoint besides the console, and it
    // writes into inbox_events. It was accepting unsigned requests from anyone.
    const verdict = verifyTelnyxWebhook({
      rawBody: requestRawBody(req),
      signature: req.headers["telnyx-signature-ed25519"] as string | undefined,
      timestamp: req.headers["telnyx-timestamp"] as string | undefined,
    });
    if (!verdict.ok) {
      await raiseIssue(pool, {
        category: "security.broker_deny",
        service: "telnyx",
        title: "[telnyx] rejected an unverified webhook",
        dedupeKey: `telnyx.unverified:${verdict.reason}`,
        evidence: { reason: verdict.reason, remote: req.ip },
        requiredAction:
          verdict.status === 503
            ? "Set TELNYX_PUBLIC_KEY on the VPS when Telnyx is configured. Until then every call to this endpoint is refused."
            : "A request reached the Telnyx webhook without a valid signature. Nothing was ingested.",
        notifyOverride: "ui_only",
      });
      return reply.code(verdict.status).send({ error: { code: "telnyx_unverified", message: verdict.reason } });
    }

    if (inQuietHours() && ((req.body ?? {}) as { data?: { event_type?: string } }).data?.event_type?.includes("call.initiated")) {
      await pool.query(
        `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
         SELECT 'low', 'telnyx.quiet_hours', 'telnyx', 'open', 'jarvis',
                '[telnyx] quiet hours — outbound skipped', 'phone.quiet'
         WHERE NOT EXISTS (SELECT 1 FROM issues WHERE dedupe_key = 'phone.quiet' AND status NOT IN ('resolved','ignored'))`,
      );
      return { ok: true, skipped: "quiet_hours" };
    }
    // Persist-first still applies: the raw event is recorded before anything
    // acts on it, so a crash in call handling cannot lose the fact that a call
    // happened.
    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
    );
    const text = JSON.stringify(req.body ?? {});
    await pool.query(
      `INSERT INTO inbox_events (channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
       VALUES ('phone', 'telnyx', $1, $2, 'persisted', 'pending', $3)`,
      [text.slice(0, 8000), checksum(text), conv.rows[0]?.id ?? null],
    );

    // Then drive the call. Telnyx retries a webhook it considers failed, so this
    // must not throw and must not block: the slow work (fetching the recording,
    // transcribing) happens on the recording event, never while a caller waits.
    const outcome = await handleCallEvent(pool, req.body as TelnyxEvent).catch((err) => {
      console.error("call handling failed:", err instanceof Error ? err.message : err);
      return "error";
    });
    return { ok: true, call: outcome };
  });

  app.post("/internal/workers/events", async (req, reply) => {
    if (!verifyInternalHmac(req, requestRawBody(req))) return reply.code(401).send({ error: "hmac" });
    // S18b: a retried post must not create a second row.
    const idem = await internalIdempotency(pool, req, "workers.events");
    if (idem.replay) return { ok: true, replay: true };
    const b = (req.body ?? {}) as {
      task_id?: string;
      type?: string;
      name?: string;
      summary?: string;
      artifact_id?: string;
    };
    if (!b.task_id) return reply.code(400).send({ error: "task_id required" });
    // Progress events go to task_events, never task_checkpoints: recovery
    // resumes from the latest checkpoint, and a tool log is not a resume point.
    const type = ["tool", "test", "git", "review", "log"].includes(b.type ?? "") ? b.type! : "log";
    await pool.query(
      `INSERT INTO task_events (task_id, type, name, summary, artifact_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [b.task_id, type, b.name ?? null, b.summary ?? null, b.artifact_id ?? null],
    );
    await pool.query(
      `UPDATE tasks SET last_tool = COALESCE($2, last_tool), updated_at = now() WHERE id = $1`,
      [b.task_id, b.name ?? null],
    );
    sseBroadcast("task.updated", { id: b.task_id, event: b.name });
    return { ok: true };
  });
}

// S14 asks for "Live updates paused" after five seconds of SSE silence, so the
// keep-alive has to be comfortably faster than the thing watching for silence.
// At fifteen seconds every healthy connection looked dead two thirds of the
// time. It is forty bytes.
setInterval(() => sseHeartbeat(), 2_000).unref();
