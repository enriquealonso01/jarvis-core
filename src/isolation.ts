import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { raiseIssue } from "./notify.js";
import { meteredRefusal } from "./quota.js";
import { audit } from "./audit.js";

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export type Denial = {
  allowed: false;
  // `budget.ceiling` is a refusal, not an isolation breach (S25). It is kept in
  // this union so every caller already handling a denial handles it too, and
  // separate from the other two so the audit row says which kind it was.
  code: "security.isolation" | "security.broker_deny" | "budget.ceiling";
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
    /**
     * Which action, when one is being performed (S31).
     *
     * Omitting it asks the weaker question - "may this project reach this
     * connection at all" - which is what routing and the runner ask when they
     * are choosing a credential rather than doing something with it. Every
     * invocation through `ConnectorInterface` names an action, so nothing that
     * actually performs work can take the weaker path by forgetting.
     */
    action?: string;
  },
): Promise<BrokerDecision> {
  const conn = await pool.query<{
    id: string;
    slug: string;
    scope: string;
    project_id: string | null;
    auth_profile_id: string | null;
    permitted_actions: string[] | null;
    disabled_at: string | null;
    disabled_reason: string | null;
  }>(
    `SELECT id, slug, scope, project_id, auth_profile_id, permitted_actions,
            disabled_at, disabled_reason
       FROM connections WHERE slug = $1`,
    [args.connectionSlug],
  );
  const c = conn.rows[0];
  if (!c) {
    return { allowed: false, code: "security.broker_deny", reason: "unknown connection" };
  }

  /*
   * Disabled means disabled, for everyone (S31).
   *
   * This sits with "connection exists" rather than beside the action check
   * because a connection Jarvis has switched off is not a thing a caller can
   * argue its way past - including the paths that ask the weaker question of
   * whether a project may reach it at all. A server that stopped answering
   * twice in a row is one the broker stops offering.
   */
  if (c.disabled_at) {
    return {
      allowed: false,
      code: "security.broker_deny",
      reason: c.disabled_reason
        ? `${c.slug} is disabled: ${c.disabled_reason}`
        : `${c.slug} is disabled`,
    };
  }

  /*
   * A connection is a set of actions, not a switch (S31).
   *
   * This sits directly under "connection exists" and above every isolation
   * check on purpose: an action that is not permitted is refused whoever asks,
   * so there is no ordering in which a project could talk its way into one.
   *
   * Empty permits NOTHING. The plan's example is the reason - "project A may
   * use Composio" and "project A may send email as Enrique" are different
   * statements, and one connection reaching hundreds of services makes the gap
   * between them enormous. This table has already been bitten twice by an
   * allowlist whose empty state meant "all", in the project and profile
   * allowlists a few lines below; it fails closed here from the start.
   */
  if (args.action !== undefined) {
    const permitted = c.permitted_actions ?? [];
    if (!permitted.includes(args.action)) {
      return {
        allowed: false,
        code: "security.broker_deny",
        reason: permitted.length
          ? `${c.slug} does not permit ${args.action}`
          : `${c.slug} permits no actions yet`,
      };
    }
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

  /*
   * A shared connection is shared with the projects on its allowlist, and with
   * no others — including when the allowlist is empty.
   *
   * The comment here already said "an empty allowlist means 'not shared with
   * anyone yet', not 'all'", and the code underneath it said the opposite: it
   * only enforced membership WHEN ROWS EXISTED, so a connection nobody had
   * allowlisted was reachable from every project. That is a gate that fails
   * open, and Part IV.4 is explicit that these fail closed.
   */
  if (c.scope === "shared" && args.projectId) {
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

  if (c.auth_profile_id) {
    const profile = await checkProfileAccess(pool, {
      authProfileId: c.auth_profile_id,
      projectId: args.projectId,
    });
    if (!profile.allowed) return profile;
  }

  /*
   * The hard spend ceiling, enforced here as well as in routing (S25).
   *
   * Routing dropping metered routes is the ordinary path; this is the one that
   * holds when something asks the broker for a metered credential directly.
   * Without it the ceiling is advisory — anything that skips `routesForRole`
   * spends past it, which is precisely the bypass the step asks to be closed.
   *
   * It is deliberately the LAST check: an isolation denial must not be reported
   * as a budget denial, because the two send whoever reads it to different
   * places. Nothing about the isolation decisions above changes here.
   */
  if (c.auth_profile_id) {
    const over = await meteredRefusal(pool, c.auth_profile_id);
    if (over) return { allowed: false, code: "budget.ceiling", reason: over };
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

    /*
     * A profile is usable by the projects on its allowlist, and by no others.
     *
     * This used to enforce membership only when the profile HAD allowlist rows,
     * and the table was empty — so every profile, telnyx and elevenlabs and the
     * subscription logins included, was permitted to every project, and only
     * `broker_only` held anything back. A gate whose default is "yes" is not a
     * gate. Part IV.4: these fail closed.
     *
     * Requests with NO project are unaffected: Jarvis's own system-wide work —
     * answering the phone, rendering speech, running a model — is not a project
     * asking for someone else's credential, and it is where these profiles are
     * legitimately used.
     */
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
  /*
   * IV.9's "connection denied", through the canonical keys. `outcome` is what
   * makes this row answer "what happened" rather than "what was tried" — and
   * for a denial the answer is the whole point.
   */
  await audit(pool, {
    actor: "broker",
    action: args.denial.code,
    target: args.connectionSlug ?? args.capability,
    projectId: args.projectId,
    taskId: args.taskId ?? null,
    tool: args.capability,
    outcome: "denied",
    reason: args.denial.reason,
  });

  if (args.denial.code === "security.isolation") {
    /*
     * A denial that WORKED is not a critical incident.
     *
     * This filed every enforced boundary as critical/open, so the queue filled
     * with the system doing its job — and criticals that fire on normal
     * behaviour get ignored, which is how the real one gets missed. The event
     * still gets an Issue, because a task reaching for something outside its
     * project is worth reading; it is `medium`, and it does not page.
     */
    await raiseIssue(pool, {
      category: "security.isolation",
      service: "broker",
      severityOverride: "medium",
      notifyOverride: "ui_only",
      title: "[security] cross-boundary access denied (nothing was granted)",
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
