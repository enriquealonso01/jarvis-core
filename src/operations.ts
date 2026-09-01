import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { hostMetrics } from "./hostmetrics.js";

/**
 * One aggregation the whole console reads: the persistent status bar, the
 * Command Center cards, and the "Needs You" panel. Keeping it in a single
 * query set means the status bar cannot disagree with the page under it.
 */
export function registerOperationsRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/operations/summary", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;

    let postgres = "down";
    try {
      await pool.query("SELECT 1");
      postgres = "up";
    } catch {
      postgres = "down";
    }

    const [
      taskCounts,
      currentHeavy,
      issueCounts,
      approvals,
      actionRequests,
      missingCreds,
      degradedProfiles,
      supervisorRoutes,
      schedules,
      backup,
      recentConversations,
      notifications,
      recentActivity,
    ] = await Promise.all([
      pool.query<{ state: string; n: string }>(
        `SELECT state, count(*)::text AS n FROM tasks
         WHERE state NOT IN ('succeeded','failed_terminal','cancelled')
         GROUP BY state`,
      ),
      pool.query(
        `SELECT t.id, t.title, t.state, t.lane, t.priority, t.model_role, t.harness, t.branch,
                t.created_at, t.updated_at, p.slug AS project_slug, p.name AS project_name
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.lane = 'heavy' AND t.state IN ('preparing','running','recovering','waiting_for_tool')
         ORDER BY t.updated_at DESC LIMIT 1`,
      ),
      pool.query<{ severity: string; status: string; n: string }>(
        `SELECT severity, status, count(*)::text AS n FROM issues
         WHERE status NOT IN ('resolved','ignored') GROUP BY severity, status`,
      ),
      pool.query(
        `SELECT id, action_type, target, environment, state, expires_at
         FROM approvals WHERE state = 'pending' ORDER BY expires_at NULLS LAST LIMIT 20`,
      ),
      pool.query(
        `SELECT a.id, a.kind, a.payload, a.created_at, a.expires_at
         FROM user_action_requests a
         LEFT JOIN issues i ON i.id = a.issue_id
         WHERE a.consumed_at IS NULL
           AND (a.expires_at IS NULL OR a.expires_at > now())
           AND (i.id IS NULL OR i.status NOT IN ('resolved', 'ignored'))
         ORDER BY a.created_at DESC LIMIT 20`,
      ),
      pool.query(
        `SELECT id, display_name, provider, auth_type
         FROM auth_profiles WHERE credential_id IS NULL ORDER BY display_name`,
      ),
      pool.query(
        `SELECT id, display_name, health FROM auth_profiles
         WHERE health IN ('degraded','expired','disabled') ORDER BY display_name`,
      ),
      pool.query(
        `SELECT provider, model_id, health, route_order, last_error
         FROM model_registry
         WHERE approval_state = 'approved' AND 'supervisor' = ANY (role_assignments)
         ORDER BY route_order LIMIT 10`,
      ),
      pool.query<{ n: string; paused: string }>(
        `SELECT count(*)::text AS n,
                count(*) FILTER (WHERE paused)::text AS paused
         FROM schedules`,
      ),
      pool.query(
        `SELECT slug, health, last_tested_at FROM connections WHERE slug = 'backup_b2'`,
      ),
      pool.query(
        `SELECT c.id, c.title, c.channel, c.last_activity_at, p.slug AS project_slug,
                (SELECT m.body FROM messages m WHERE m.conversation_id = c.id
                  ORDER BY m.created_at DESC LIMIT 1) AS last_message
         FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
         ORDER BY c.last_activity_at DESC LIMIT 6`,
      ),
      pool.query(
        `SELECT id, channel, message_type, body, state, created_at
         FROM notifications_outbox ORDER BY created_at DESC LIMIT 10`,
      ),
      // Plan §39: recent project activity. Routine reads are excluded — an
      // activity feed of "broker.invoke" every few seconds tells you nothing.
      pool.query(
        `SELECT e.at, e.actor, e.action, e.target, p.slug AS project_slug, p.name AS project_name
         FROM audit_events e
         LEFT JOIN projects p ON p.id = e.project_id
         WHERE e.action NOT IN ('broker.invoke')
         ORDER BY e.at DESC LIMIT 12`,
      ),
    ]);

    const byState: Record<string, number> = {};
    for (const row of taskCounts.rows) byState[row.state] = Number(row.n);
    const count = (...states: string[]) => states.reduce((a, s) => a + (byState[s] ?? 0), 0);

    const openIssues = issueCounts.rows.reduce((a, r) => a + Number(r.n), 0);
    const criticalIssues = issueCounts.rows
      .filter((r) => r.severity === "critical")
      .reduce((a, r) => a + Number(r.n), 0);
    const highIssues = issueCounts.rows
      .filter((r) => r.severity === "high")
      .reduce((a, r) => a + Number(r.n), 0);

    // Routable, not necessarily pristine: a degraded route still answers, so it
    // is not an incident on its own.
    const supervisorRoutable = supervisorRoutes.rows.some((r) =>
      ["healthy", "degraded"].includes(String(r.health)),
    );
    const supervisorHealthy = supervisorRoutes.rows.some((r) => r.health === "healthy");

    // Needs You: everything that is blocked on Enrique, with where to go.
    const needsYou: {
      kind: string;
      title: string;
      detail: string;
      href: string;
      severity: "critical" | "high" | "medium";
    }[] = [];
    for (const a of approvals.rows as { id: string; action_type: string; target: string | null }[]) {
      needsYou.push({
        kind: "approval",
        title: `Approve: ${a.action_type}`,
        detail: a.target ?? "",
        href: "/approvals/",
        severity: "high",
      });
    }
    // An action request is the actionable form of a blocker, so it wins over the
    // bare "this profile has no credential" line for the same profile — showing
    // both makes the panel look twice as blocked as it is.
    const coveredProfiles = new Set<string>();
    for (const r of actionRequests.rows as {
      id: string;
      kind: string;
      payload: { title?: string; message?: string; profile_id?: string | null };
    }[]) {
      if (r.payload?.profile_id) coveredProfiles.add(r.payload.profile_id);
      needsYou.push({
        kind: "action_request",
        title: r.payload?.title ?? r.kind.replace(/_/g, " "),
        detail: r.payload?.message?.slice(0, 160) ?? "",
        href: `/actions/?id=${r.id}`,
        severity: "high",
      });
    }
    for (const p of missingCreds.rows as { id: string; display_name: string; auth_type: string }[]) {
      if (coveredProfiles.has(p.id)) continue;
      needsYou.push({
        kind: "credential",
        title: `Connect ${p.display_name}`,
        detail: p.auth_type === "subscription_login" ? "host login on the VPS" : "API key missing",
        href: "/connections/",
        severity: "medium",
      });
    }
    for (const p of degradedProfiles.rows as { id: string; display_name: string; health: string }[]) {
      needsYou.push({
        kind: "credential",
        title: `${p.display_name} is ${p.health}`,
        detail: "Reconnect or rotate the credential",
        href: "/connections/",
        severity: "high",
      });
    }
    if (!supervisorRoutable) {
      needsYou.push({
        kind: "routing",
        title: "No healthy Supervisor model route",
        detail: supervisorRoutes.rows[0]?.last_error
          ? String(supervisorRoutes.rows[0].last_error).slice(0, 160)
          : "Every approved supervisor route is failing",
        href: "/models/",
        severity: "critical",
      });
    }

    const status: "healthy" | "degraded" | "incident" =
      postgres !== "up" || criticalIssues > 0 || !supervisorRoutable
        ? "incident"
        : highIssues > 0 || degradedProfiles.rowCount
          ? "degraded"
          : "healthy";

    return {
      status,
      checked_at: new Date().toISOString(),
      // Plan §39: CPU/RAM/disk/I/O belong on the Command Center.
      host: await hostMetrics(),
      services: {
        postgres,
        supervisor_routing: supervisorHealthy
          ? "healthy"
          : supervisorRoutable
            ? "degraded"
            : "failed",
      },
      queue: {
        running: count("running", "preparing"),
        queued: count("queued"),
        blocked: count("stalled", "recovering", "retry_scheduled"),
        waiting_for_user: count("waiting_for_user"),
        waiting_for_approval: count("waiting_for_approval"),
        waiting_for_provider: count("waiting_for_provider"),
        paused: count("paused"),
        depth: count("queued", "preparing", "running", "recovering", "retry_scheduled"),
      },
      current_heavy_task: currentHeavy.rows[0] ?? null,
      issues: { open: openIssues, critical: criticalIssues, high: highIssues },
      needs_you: needsYou,
      needs_you_count: needsYou.length,
      supervisor_routes: supervisorRoutes.rows,
      schedules: {
        total: Number(schedules.rows[0]?.n ?? 0),
        paused: Number(schedules.rows[0]?.paused ?? 0),
      },
      backup: backup.rows[0] ?? null,
      recent_conversations: recentConversations.rows,
      notifications: notifications.rows,
      recent_activity: recentActivity.rows,
    };
  });
}
