import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { raiseIssue } from "./notify.js";

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export type Denial = {
  allowed: false;
  code: "security.isolation" | "security.broker_deny";
  reason: string;
};

export type Grant = { allowed: true; connectionId: string | null; authProfileId: string | null };

export type BrokerDecision = Denial | Grant;

/**
 * CREDENTIAL_BROKER.md check order, steps 3-5. These tables existed in the
 * schema and were referenced by no code at all, which meant the "project
 * allowlist" and "role allowlist" checks the broker is specified around were
 * not happening anywhere.
 *
 * Fails closed: anything not positively permitted is denied and audited.
 */
export async function checkConnectionAccess(
  pool: pg.Pool,
  args: {
    connectionSlug: string;
    projectId: string | null;
    taskId?: string | null;
    capability?: string;
  },
): Promise<BrokerDecision> {
  const conn = await pool.query<{
    id: string;
    slug: string;
    scope: string;
    project_id: string | null;
    auth_profile_id: string | null;
  }>(
    `SELECT id, slug, scope, project_id, auth_profile_id FROM connections WHERE slug = $1`,
    [args.connectionSlug],
  );
  const c = conn.rows[0];
  if (!c) {
    return { allowed: false, code: "security.broker_deny", reason: "unknown connection" };
  }

  // A project-scoped connection belongs to exactly one project. Asking for
  // another project's connection by name is the cross-project probe in L9.
  if (c.scope === "project") {
    if (!args.projectId || c.project_id !== args.projectId) {
      return {
        allowed: false,
        code: "security.isolation",
        reason: `connection ${c.slug} belongs to another project`,
      };
    }
  }

  // The GitHub admin profile is broker-only and must never be selectable as a
  // project connection (CREDENTIAL_BROKER.md).
  if (c.auth_profile_id === "github_personal_admin" && args.projectId) {
    return {
      allowed: false,
      code: "security.isolation",
      reason: "the GitHub admin profile is broker-only and cannot be used by a project",
    };
  }

  // When an explicit allowlist exists for a shared connection, membership is
  // required — an empty allowlist means "not shared with anyone yet", not "all".
  if (c.scope === "shared") {
    const list = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connection_project_allowlist WHERE connection_id = $1`,
      [c.id],
    );
    if (Number(list.rows[0]?.n ?? 0) > 0) {
      const member = await pool.query(
        `SELECT 1 FROM connection_project_allowlist WHERE connection_id = $1 AND project_id = $2`,
        [c.id, args.projectId],
      );
      if (!member.rowCount) {
        return {
          allowed: false,
          code: "security.isolation",
          reason: `project is not on the allowlist for ${c.slug}`,
        };
      }
    }
  }

  if (c.auth_profile_id) {
    const profile = await checkProfileAccess(pool, {
      authProfileId: c.auth_profile_id,
      projectId: args.projectId,
    });
    if (!profile.allowed) return profile;
  }

  return { allowed: true, connectionId: c.id, authProfileId: c.auth_profile_id };
}

/**
 * Plan §80.1 plus confidentiality eligibility: a profile may be restricted to
 * named projects and roles, and may be ineligible for a project's
 * confidentiality class regardless of any allowlist.
 */
export async function checkProfileAccess(
  pool: pg.Pool,
  args: { authProfileId: string; projectId: string | null; role?: string },
): Promise<BrokerDecision> {
  const prof = await pool.query<{
    id: string;
    confidentiality_eligibility: string[];
    health: string;
  }>(
    `SELECT id, confidentiality_eligibility, health FROM auth_profiles WHERE id = $1`,
    [args.authProfileId],
  );
  const p = prof.rows[0];
  if (!p) return { allowed: false, code: "security.broker_deny", reason: "unknown auth profile" };

  if (args.projectId) {
    const project = await pool.query<{ confidentiality: string }>(
      `SELECT confidentiality FROM projects WHERE id = $1`,
      [args.projectId],
    );
    const conf = project.rows[0]?.confidentiality;
    if (conf && !(p.confidentiality_eligibility ?? []).includes(conf)) {
      return {
        allowed: false,
        code: "security.isolation",
        reason: `${p.id} is not eligible for ${conf} projects`,
      };
    }

    // If this profile has any project allowlist rows, it is restricted to them.
    const scoped = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_profile_allowlists WHERE auth_profile_id = $1`,
      [p.id],
    );
    if (Number(scoped.rows[0]?.n ?? 0) > 0) {
      const row = await pool.query<{ allowed_roles: string[] }>(
        `SELECT allowed_roles FROM auth_profile_allowlists
         WHERE auth_profile_id = $1 AND project_id = $2`,
        [p.id, args.projectId],
      );
      if (!row.rows[0]) {
        return {
          allowed: false,
          code: "security.isolation",
          reason: `${p.id} is not allowlisted for this project`,
        };
      }
      const roles = row.rows[0].allowed_roles ?? [];
      if (args.role && roles.length > 0 && !roles.includes(args.role)) {
        return {
          allowed: false,
          code: "security.isolation",
          reason: `${p.id} is not allowlisted for the ${args.role} role here`,
        };
      }
    }
  }

  return { allowed: true, connectionId: null, authProfileId: p.id };
}

/** Every denial is audited; cross-project probing also raises an Issue. */
export async function recordDenial(
  pool: pg.Pool,
  args: {
    denial: Denial;
    capability: string;
    projectId: string | null;
    taskId?: string | null;
    connectionSlug?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, project_id, metadata)
     VALUES ('broker', $1, $2, $3, $4)`,
    [
      args.denial.code,
      args.connectionSlug ?? args.capability,
      args.projectId,
      JSON.stringify({
        capability: args.capability,
        reason: args.denial.reason,
        task_id: args.taskId ?? null,
      }),
    ],
  );

  if (args.denial.code === "security.isolation") {
    await raiseIssue(pool, {
      category: "security.isolation",
      service: "broker",
      title: "[security] cross-boundary access denied",
      dedupeKey: `sec.isolation:${args.projectId ?? "system"}:${args.connectionSlug ?? args.capability}`,
      projectId: args.projectId,
      taskId: args.taskId ?? null,
      evidence: { capability: args.capability, reason: args.denial.reason },
      requiredAction:
        "A task asked for something outside its project. Nothing was granted. Review the task if this was not expected.",
    });
  }
}

export function registerIsolationRoutes(app: FastifyInstance, pool: pg.Pool) {
  /**
   * The broker entry point. Every capability call resolves a connection through
   * here, so the isolation rules are enforced in one place rather than at each
   * call site.
   */
  app.post("/api/broker/resolve", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });

    const b = (req.body ?? {}) as {
      capability?: string;
      connection_slug?: string;
      project_slug?: string;
      project_id?: string;
      task_id?: string;
    };
    if (!b.capability || !b.connection_slug) {
      return reply.code(400).send({ error: "capability and connection_slug required" });
    }

    let projectId: string | null = b.project_id ?? null;
    if (!projectId && b.project_slug) {
      const p = await pool.query<{ id: string }>("SELECT id FROM projects WHERE slug = $1", [
        b.project_slug,
      ]);
      projectId = p.rows[0]?.id ?? null;
      if (!projectId) return reply.code(404).send({ error: "project not found" });
    }

    const decision = await checkConnectionAccess(pool, {
      connectionSlug: b.connection_slug,
      projectId,
      taskId: b.task_id ?? null,
      capability: b.capability,
    });

    if (!decision.allowed) {
      await recordDenial(pool, {
        denial: decision,
        capability: b.capability,
        projectId,
        taskId: b.task_id ?? null,
        connectionSlug: b.connection_slug,
      });
      return reply.code(403).send({
        error: { code: decision.code, message: decision.reason },
      });
    }

    // Never returns the secret — only that the caller may use it, and which
    // profile the broker would unwrap on their behalf.
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('broker', 'broker.invoke', $1, $2, $3)`,
      [
        b.connection_slug,
        projectId,
        JSON.stringify({ capability: b.capability, task_id: b.task_id ?? null }),
      ],
    );
    return {
      allowed: true,
      connection_slug: b.connection_slug,
      auth_profile_id: decision.authProfileId,
    };
  });
}
