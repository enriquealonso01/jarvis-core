import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { cronNextRun } from "./cron.js";
import { sitePin } from "./siteconfig.js";
import { telnyxPublicKey } from "./telnyx.js";

/**
 * Plan §42 names sixteen things health "covers". Several are not configured yet
 * (OpenClaw, WhatsApp, Telnyx, ElevenLabs voice). Reporting only the ones that
 * happen to be wired makes an incomplete system look complete, so every service
 * the plan names is listed with an explicit state — including
 * `not_configured`, which is a real answer rather than an absence.
 */
export type ServiceState = "healthy" | "degraded" | "failed" | "not_configured" | "unknown";

export type ServiceRow = {
  key: string;
  label: string;
  state: ServiceState;
  detail: string;
  gated: boolean;
};

export function registerServiceRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/operations/services", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;

    const rows: ServiceRow[] = [];
    const add = (r: ServiceRow) => rows.push(r);

    // --- Jarvis API + PostgreSQL ---
    let pgState: ServiceState = "failed";
    let pgDetail = "unreachable";
    try {
      const t0 = Date.now();
      await pool.query("SELECT 1");
      pgState = "healthy";
      pgDetail = `responded in ${Date.now() - t0} ms`;
    } catch (err) {
      pgDetail = err instanceof Error ? err.message.slice(0, 120) : "query failed";
    }
    add({ key: "api", label: "Jarvis API", state: "healthy", detail: "serving this request", gated: false });
    add({ key: "postgres", label: "PostgreSQL", state: pgState, detail: pgDetail, gated: false });

    // --- infrastructure (host) ---
    const incidents = await pool.query<{ service: string; severity: string; summary: string | null }>(
      `SELECT service, severity, summary FROM health_incidents WHERE closed_at IS NULL`,
    );
    const openBy = new Map(incidents.rows.map((i) => [i.service, i]));
    const infra = ["disk", "ram", "queue"].filter((s) => openBy.has(s));
    add({
      key: "infrastructure",
      label: "Infrastructure",
      state: infra.length ? "degraded" : "healthy",
      detail: infra.length ? `open incidents: ${infra.join(", ")}` : "disk, memory and queue within limits",
      gated: false,
    });

    // --- workers ---
    const workers = await pool.query<{ n: string; stale: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE heartbeat_at < now() - interval '90 seconds')::text AS stale
       FROM tasks WHERE state IN ('running','preparing')`,
    );
    const staleCount = Number(workers.rows[0]?.stale ?? 0);
    add({
      key: "workers",
      label: "Workers",
      state: staleCount > 0 ? "degraded" : "healthy",
      detail: staleCount > 0
        ? `${staleCount} task(s) past their heartbeat window`
        : `${workers.rows[0]?.n ?? 0} task(s) in flight, all heartbeating`,
      gated: false,
    });

    // --- queue ---
    const queue = await pool.query<{ blocked: string; depth: string }>(
      `SELECT count(*) FILTER (WHERE state IN ('stalled','recovering'))::text AS blocked,
              count(*) FILTER (WHERE state NOT IN ('succeeded','failed_terminal','cancelled'))::text AS depth
       FROM tasks`,
    );
    add({
      key: "queue",
      label: "Queue",
      state: Number(queue.rows[0]?.blocked ?? 0) > 0 ? "degraded" : "healthy",
      detail: `${queue.rows[0]?.depth ?? 0} open, ${queue.rows[0]?.blocked ?? 0} blocked`,
      gated: false,
    });

    // --- providers / models ---
    const models = await pool.query<{ healthy: string; degraded: string; total: string }>(
      `SELECT count(*) FILTER (WHERE health = 'healthy')::text AS healthy,
              count(*) FILTER (WHERE health = 'degraded')::text AS degraded,
              count(*)::text AS total
       FROM model_registry WHERE approval_state = 'approved' AND endpoint_url IS NOT NULL`,
    );
    const mh = Number(models.rows[0]?.healthy ?? 0);
    const md = Number(models.rows[0]?.degraded ?? 0);
    add({
      key: "models",
      label: "Providers / models",
      state: mh > 0 ? "healthy" : md > 0 ? "degraded" : "failed",
      detail: `${mh} healthy, ${md} degraded of ${models.rows[0]?.total ?? 0} routable`,
      gated: false,
    });

    // --- connections (MCP / integrations) ---
    const conns = await pool.query<{ slug: string; health: string; has_cred: boolean }>(
      `SELECT c.slug, c.health, (COALESCE(c.credential_id, a.credential_id) IS NOT NULL) AS has_cred
       FROM connections c LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id`,
    );
    const connected = conns.rows.filter((c) => c.has_cred);
    const unhealthy = connected.filter((c) => c.health !== "healthy");
    add({
      key: "connections",
      label: "MCP / connections",
      state: unhealthy.length ? "degraded" : connected.length ? "healthy" : "not_configured",
      detail: `${connected.length} connected of ${conns.rows.length}` +
        (unhealthy.length ? `, ${unhealthy.map((c) => c.slug).join(", ")} not healthy` : ""),
      gated: false,
    });

    // --- schedules ---
    // Staleness has to be judged against each schedule's own cadence. A fixed
    // window marks a weekly job stale every week, which is a false alarm that
    // trains you to ignore the row.
    const sched = await pool.query<{
      id: string;
      name: string;
      cron: string;
      timezone: string;
      paused: boolean;
      last_run_at: string | null;
      created_at: string;
    }>(
      `SELECT s.id, s.name, s.cron, s.timezone, s.paused, s.created_at,
              (SELECT max(r.started_at) FROM schedule_runs r WHERE r.schedule_id = s.id) AS last_run_at
       FROM schedules s`,
    );

    const GRACE_MS = 15 * 60 * 1000;
    const overdue: string[] = [];
    for (const row of sched.rows) {
      if (row.paused) continue;
      const since = new Date(row.last_run_at ?? row.created_at);
      const due = cronNextRun(row.cron, since, row.timezone || "America/New_York");
      if (due && due.getTime() < Date.now() - GRACE_MS) overdue.push(row.name);
    }
    const paused = sched.rows.filter((r) => r.paused).length;
    add({
      key: "schedules",
      label: "Schedules",
      state: overdue.length ? "degraded" : "healthy",
      detail: overdue.length
        ? `${overdue.join(", ")} overdue against its own cadence`
        : `${sched.rows.length} registered, ${paused} paused, all on cadence`,
      gated: false,
    });

    // --- backups ---
    const drill = await pool.query<{ action: string; at: string }>(
      `SELECT action, at FROM audit_events
       WHERE action LIKE 'backup.restore_drill.%' ORDER BY at DESC LIMIT 1`,
    );
    const lastDrill = drill.rows[0];
    add({
      key: "backups",
      label: "Backups",
      state: !lastDrill
        ? "unknown"
        : lastDrill.action.endsWith(".pass")
          ? "healthy"
          : "failed",
      detail: lastDrill
        ? `last restore drill ${lastDrill.action.endsWith(".pass") ? "passed" : "FAILED"} at ${new Date(lastDrill.at).toISOString().slice(0, 16)}`
        : "no restore drill has run yet",
      gated: false,
    });

    // --- security / isolation ---
    const iso = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
       WHERE category IN ('security.isolation','security.retention_breach')
         AND status NOT IN ('resolved','ignored')`,
    );
    add({
      key: "security",
      label: "Security / isolation",
      state: Number(iso.rows[0]?.n ?? 0) > 0 ? "degraded" : "healthy",
      detail: Number(iso.rows[0]?.n ?? 0) > 0
        ? `${iso.rows[0].n} open isolation issue(s)`
        : "no open isolation or retention issues",
      gated: false,
    });

    // --- browsers ---
    add({
      key: "browsers",
      label: "Browsers",
      state: "not_configured",
      detail: "no browser worker has run yet (Phase 4)",
      gated: false,
    });

    // --- gated channels ---
    const allowlist = await pool.query<{ channel: string }>(
      `SELECT DISTINCT channel FROM channel_allowlist`,
    );
    const channels = new Set(allowlist.rows.map((r) => r.channel));

    // Notification delivery. Nine blockers had exhausted their retries on the
    // WhatsApp channel and nothing said so anywhere — the rows sat `failed` in
    // the outbox and no page or health check read them. That was harmless only
    // because WhatsApp is unpaired and every one of those blockers also went out
    // over the UI channel; a *configured* channel failing the same way would
    // have looked identical, which is to say invisible.
    //
    // Failures on a channel that is not configured are expected, not an
    // incident, so they are reported without changing the state.
    const outbox = await pool.query<{ channel: string; n: string }>(
      `SELECT channel, count(*)::text AS n
       FROM notifications_outbox WHERE state = 'failed'
       GROUP BY channel`,
    );
    const configured = (channel: string) =>
      channel === "ui" || channels.has(channel);
    const liveFailures = outbox.rows.filter((r) => configured(r.channel));
    const gatedFailures = outbox.rows.filter((r) => !configured(r.channel));
    const describe = (rows: { channel: string; n: string }[]) =>
      rows.map((r) => `${r.channel} ${r.n}`).join(", ");
    add({
      key: "notifications",
      label: "Notification delivery",
      state: liveFailures.length ? "degraded" : "healthy",
      detail: liveFailures.length
        ? `undelivered on a configured channel: ${describe(liveFailures)}`
        : gatedFailures.length
          ? `all delivered; ${describe(gatedFailures)} undelivered on channels that are not paired yet`
          : "no undelivered notifications",
      gated: false,
    });

    add({
      key: "openclaw",
      label: "OpenClaw",
      state: "not_configured",
      detail: "container profile not started; WhatsApp pairing is pending",
      gated: true,
    });
    add({
      key: "whatsapp",
      label: "WhatsApp",
      state: channels.has("whatsapp") ? "healthy" : "not_configured",
      detail: channels.has("whatsapp")
        ? "allowlist configured"
        : "no allowlist entry; QR pairing not done",
      gated: true,
    });
    add({
      key: "telnyx",
      label: "Telnyx",
      state: telnyxPublicKey() ? "healthy" : "not_configured",
      detail: telnyxPublicKey()
        ? `signing key set; webhook verifies${sitePin((c) => c.telnyx?.from_e164) ? "" : " (no from_e164 pinned yet)"}`
        : "no signing key in site.yaml or env, so the webhook refuses everything by design",
      gated: true,
    });

    const eleven = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_profiles
       WHERE id = 'elevenlabs' AND credential_id IS NOT NULL`,
    );
    // Read the file rather than assert about it. This line used to say "no
    // voice_id pinned in site.yaml yet" whenever a credential existed — true on
    // day one and never updated, because nothing parsed the file.
    const voiceId = sitePin((c) => c.elevenlabs?.voice_id);
    const hasElevenKey = Number(eleven.rows[0]?.n ?? 0) > 0;
    add({
      key: "elevenlabs",
      label: "ElevenLabs",
      state: hasElevenKey && voiceId ? "healthy" : hasElevenKey ? "degraded" : "not_configured",
      detail: !hasElevenKey
        ? "no credential"
        : voiceId
          ? `key stored; voice ${voiceId} pinned`
          : "key stored; no voice_id pinned in site.yaml yet",
      gated: true,
    });

    const worst: ServiceState = rows.some((r) => !r.gated && r.state === "failed")
      ? "failed"
      : rows.some((r) => !r.gated && r.state === "degraded")
        ? "degraded"
        : "healthy";

    return {
      overall: worst,
      checked_at: new Date().toISOString(),
      services: rows,
      // Gated services are excluded from `overall` — they are pending setup,
      // not broken, and folding them in would make the box look unhealthy forever.
      gated_count: rows.filter((r) => r.gated && r.state === "not_configured").length,
    };
  });
}
