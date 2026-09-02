import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { isAlwaysConfirm } from "./policy.js";
import { bindingSha } from "./reauth.js";
import { sseBroadcast } from "./sse.js";

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export function registerGrantRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/grants", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT id, task_id, project_id, actions, repo, environment, allowed_sha, expires_at, invalidated_at, created_at
       FROM task_grants ORDER BY created_at DESC LIMIT 100`,
    );
    return { grants: r.rows };
  });

  app.post("/api/tasks/:id/grants", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const taskId = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as {
      project_id?: string;
      actions?: string[];
      repo?: string;
      environment?: string;
      hours?: number;
    };
    if (!b.project_id || !b.actions?.length) {
      return reply.code(400).send({ error: "project_id and actions required" });
    }
    if (b.actions.some(isAlwaysConfirm)) {
      return reply.code(400).send({
        error: {
          code: "broker_deny",
          message: "Always-confirm actions cannot be satisfied by a task grant. Open an approval.",
        },
      });
    }
    const hours = b.hours ?? 4;
    const r = await pool.query(
      `INSERT INTO task_grants (task_id, project_id, actions, repo, environment, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 hour'))
       RETURNING *`,
      [taskId, b.project_id, b.actions, b.repo ?? null, b.environment ?? null, String(hours)],
    );
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('user', 'grant.create', $1, $2, $3)`,
      [r.rows[0].id, b.project_id, JSON.stringify({ actions: b.actions, repo: b.repo })],
    );
    return { grant: r.rows[0] };
  });

  app.post("/api/grants/:id/invalidate", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? "user";
    await pool.query(
      `UPDATE task_grants SET invalidated_at = now(), invalidate_reason = $2 WHERE id = $1`,
      [id, reason],
    );
    return { ok: true };
  });

  app.post("/api/approvals", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as {
      action_type?: string;
      project_id?: string;
      target?: string;
      environment?: string;
      resource_version?: string;
      task_id?: string;
    };
    if (!b.action_type) return reply.code(400).send({ error: "action_type required" });
    /*
     * The approval is bound to exactly what it approves (Part V).
     *
     * The hash covers the action, its target, the environment and the state
     * version it was computed against. If any of them is rewritten before the
     * click lands, the recomputed hash differs and the decision is refused —
     * rather than applied to whatever is current now, with a complete audit
     * trail saying it was authorised.
     */
    const binding = bindingSha({
      actionType: b.action_type,
      target: b.target ?? null,
      environment: b.environment ?? null,
      resourceVersion: b.resource_version ?? null,
      projectId: b.project_id ?? null,
    });
    const r = await pool.query(
      `INSERT INTO approvals (action_type, project_id, target, environment, resource_version, task_id,
                              state, expires_at, binding_sha, requires_reauth)
       VALUES ($1,$2,$3,$4,$5,$6,'pending', now() + interval '24 hours', $7, $8) RETURNING *`,
      [
        b.action_type,
        b.project_id ?? null,
        b.target ?? null,
        b.environment ?? null,
        b.resource_version ?? null,
        b.task_id ?? null,
        binding,
        isAlwaysConfirm(b.action_type),
      ],
    );
    sseBroadcast("approval.updated", { id: r.rows[0].id });
    return { approval: r.rows[0], always_confirm: isAlwaysConfirm(b.action_type) };
  });

  app.post("/api/broker/github", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as { action?: string; approval_id?: string };
    if (!b.action) return reply.code(400).send({ error: "action required" });
    if (isAlwaysConfirm(b.action)) {
      if (!b.approval_id) {
        return reply.code(403).send({
          error: { code: "broker_deny", message: "Always-confirm action needs a live approval." },
        });
      }
      const ap = await pool.query<{ state: string; action_type: string; expires_at: Date | null }>(
        `SELECT state, action_type, expires_at FROM approvals WHERE id = $1`,
        [b.approval_id],
      );
      const row = ap.rows[0];
      if (!row || row.state !== "approved" || row.action_type !== b.action) {
        return reply.code(403).send({
          error: { code: "broker_deny", message: "Approval missing, expired, or unbound." },
        });
      }
      if (row.expires_at && row.expires_at.getTime() < Date.now()) {
        return reply.code(403).send({ error: { code: "broker_deny", message: "Approval expired." } });
      }
    }
    return reply.code(501).send({
      error: { code: "broker_deny", message: "High-risk GitHub mutations are not executed without a bound live approval and SHA." },
    });
  });
}
