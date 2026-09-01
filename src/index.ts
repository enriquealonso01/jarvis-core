import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { createPool, migrate } from "./db.js";
import { ensureBootstrapUser, registerAuthRoutes, requireUser } from "./auth.js";
import { ingestResticEnv } from "./ingest-restic.js";
import { registerSetupRoutes } from "./setup.js";
import { verifyCatalogs } from "./catalog.js";
import { ingestUserMessage } from "./inbox.js";
import { sseBroadcast } from "./sse.js";
import { registerProductRoutes } from "./product.js";
import { registerGrantRoutes } from "./grants.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerActionRoutes } from "./actions.js";
import { registerIsolationRoutes } from "./isolation.js";
import { registerServiceRoutes } from "./services.js";
import { ensureActionRequests, ensureBlockedIssues } from "./blockers.js";
import type { RawRequest } from "./hmac.js";

const pool = createPool();

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: { headers: { origin?: string } }): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

async function supervisorRouting(): Promise<"healthy" | "degraded" | "missing"> {
  // A stored key is not a working route. Degraded routes are still routable —
  // a rate-limited primary is not an outage while a fallback answers — so the
  // three states are reported separately instead of collapsing to a boolean.
  const r = await pool.query<{ health: string }>(
    `SELECT health FROM model_registry
     WHERE approval_state = 'approved'
       AND endpoint_url IS NOT NULL
       AND health IN ('healthy', 'degraded')
       AND 'supervisor' = ANY (role_assignments)`,
  );
  if (!r.rowCount) return "missing";
  return r.rows.some((x) => x.health === "healthy") ? "healthy" : "degraded";
}

async function main() {
  await migrate(pool);
  const boot = await ensureBootstrapUser(pool);
  if (boot.created) {
    console.log(`bootstrap user created; password written to ${boot.oncePath} (not logged)`);
  }

  const restic = await ingestResticEnv(pool);
  if (restic.ingested) {
    console.log(`backup_b2 credential stored fingerprint=${restic.fingerprint}`);
  }
  // Catalog verification makes live calls to every provider. A cold or
  // rate-limited endpoint must never keep the API from listening, so it runs
  // after startup; routing falls back to whatever the registry already holds.
  // Fixed phone lines are rendered once at boot, not on the first call.
  void import("./callcontrol.js").then((m) => m.warmPhoneAudio(pool)).catch(() => undefined);

  void verifyCatalogs(pool)
    .then((catalogs) => console.log(`catalogs groq=${catalogs.groq} ${catalogs.notes.join("; ")}`))
    .catch((err) => console.error("catalog verification failed", err));
  await ensureBlockedIssues(pool);
  await ensureActionRequests(pool);

  const app = Fastify({ logger: true, trustProxy: true });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
    (req as RawRequest).rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(cookie);
  // Attachments (API_AND_EVENTS.md: POST /api/inbox multipart). The cap is
  // enforced here as well as in the stream, so a large body is refused before
  // it is written rather than after.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 5, fields: 20 },
  });

  // API_AND_EVENTS.md: correlation id on every response, echoed if the caller
  // supplied one. Without it a report of "it failed" cannot be tied to a log line.
  app.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming) ? incoming : req.id;
    (req as unknown as { correlationId: string }).correlationId = String(id);
    reply.header("X-Request-Id", String(id));
  });

  // No stack traces to the UI, and the correlation id travels with the error.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const id = (req as unknown as { correlationId?: string }).correlationId ?? req.id;
    req.log.error({ err, correlationId: id }, "request failed");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: {
        code: status === 500 ? "internal" : "request_failed",
        message: status === 500 ? "Something failed on the server." : err.message,
        request_id: String(id),
      },
    });
  });

  app.get("/api/health", async () => {
    let postgres = "down";
    try {
      await pool.query("SELECT 1");
      postgres = "up";
    } catch {
      postgres = "down";
    }
    const routing = await supervisorRouting();
    return {
      ok: postgres === "up",
      service: "jarvis",
      phase: 3,
      postgres,
      supervisor_route: routing,
      // Composing stays enabled while any route can still be reached.
      compose_enabled: routing !== "missing",
    };
  });

  registerAuthRoutes(app, pool);
  registerSetupRoutes(app, pool);
  registerProductRoutes(app, pool);
  registerGrantRoutes(app, pool);
  registerOperationsRoutes(app, pool);
  registerActionRoutes(app, pool);
  registerIsolationRoutes(app, pool);
  registerServiceRoutes(app, pool);

  app.get("/api/projects", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT p.id, p.slug, p.name, p.is_system, p.project_type, p.confidentiality,
              p.production_status, p.customer_facing, p.github_owner, p.github_repo,
              p.default_branch, p.default_queue_priority, p.created_at,
              (SELECT count(*) FROM tasks t
                WHERE t.project_id = p.id
                  AND t.state IN ('queued','preparing','running','recovering',
                                  'waiting_for_user','waiting_for_approval','waiting_for_provider'))::int
                AS open_tasks,
              (SELECT count(*) FROM issues i
                WHERE i.project_id = p.id AND i.status NOT IN ('resolved','ignored'))::int
                AS open_issues,
              (SELECT count(*) FROM conversations c WHERE c.project_id = p.id)::int AS thread_count,
              (SELECT count(*) FROM schedules s WHERE s.project_id = p.id AND NOT s.paused)::int
                AS active_schedules,
              -- Worst health among this project's own connections; NULL when it
              -- has none of its own and uses the shared system ones.
              (SELECT CASE
                        WHEN bool_or(c2.health = 'failed') THEN 'failed'
                        WHEN bool_or(c2.health = 'degraded') THEN 'degraded'
                        WHEN bool_or(c2.health = 'healthy') THEN 'healthy'
                        ELSE NULL
                      END
                 FROM connections c2 WHERE c2.project_id = p.id) AS connection_health,
              (SELECT count(*) FROM tasks t
                WHERE t.project_id = p.id AND t.state = 'failed_terminal'
                  AND t.updated_at > now() - interval '7 days')::int AS recent_failures,
              (SELECT count(*) FROM task_transitions tt
                JOIN tasks t2 ON t2.id = tt.task_id
                WHERE t2.project_id = p.id AND tt.to_state = 'recovering'
                  AND tt.at > now() - interval '7 days')::int AS recent_recoveries,
              GREATEST(
                p.created_at,
                COALESCE((SELECT max(c.last_activity_at) FROM conversations c WHERE c.project_id = p.id), p.created_at),
                COALESCE((SELECT max(t.updated_at) FROM tasks t WHERE t.project_id = p.id), p.created_at)
              ) AS last_activity_at
       FROM projects p
       WHERE p.archived_at IS NULL
       ORDER BY p.is_system DESC, p.name`,
    );
    return { projects: r.rows };
  });

  app.get("/api/conversations", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT id, project_id, title, channel, created_at, last_activity_at
       FROM conversations ORDER BY last_activity_at DESC`,
    );
    return { conversations: r.rows };
  });

  app.post("/api/conversations", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const b = (req.body ?? {}) as { title?: string; project_id?: string; project_slug?: string };
    let projectId: string | null = b.project_id ?? null;
    if (!projectId && b.project_slug) {
      const p = await pool.query<{ id: string }>("SELECT id FROM projects WHERE slug = $1", [
        b.project_slug,
      ]);
      if (!p.rows[0]) return reply.code(404).send({ error: "project not found" });
      projectId = p.rows[0].id;
    }
    const r = await pool.query(
      `INSERT INTO conversations (project_id, title, channel)
       VALUES ($1, $2, 'web')
       RETURNING id, project_id, title, channel, created_at, last_activity_at`,
      // No placeholder title: an untitled thread is named by its first message
      // (see deriveThreadTitle), so nothing has to be typed before talking.
      [projectId, (b.title ?? "").trim() || null],
    );
    return reply.code(201).send({ conversation: r.rows[0] });
  });

  app.patch("/api/conversations/:id", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { title?: string; project_id?: string | null };
    const r = await pool.query(
      `UPDATE conversations
       SET title = COALESCE($2, title),
           project_id = CASE WHEN $3::boolean THEN $4::uuid ELSE project_id END
       WHERE id = $1
       RETURNING id, project_id, title, channel, created_at, last_activity_at`,
      [id, b.title ?? null, Object.prototype.hasOwnProperty.call(b, "project_id"), b.project_id ?? null],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not found" });
    return { conversation: r.rows[0] };
  });

  app.get("/api/conversations/:id/messages", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{ id: string; inbox_event_id: string | null }>(
      `SELECT id, role, body, created_at, inbox_event_id
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    // What Jarvis actually did in each turn, not just what it said it did.
    // Plan §41's principle — observable actions, never hidden reasoning —
    // applies to conversations as much as to tasks.
    const tools = await pool.query<{
      inbox_id: string;
      action: string;
      target: string | null;
      result: string | null;
      at: string;
    }>(
      `SELECT metadata->>'inbox_id' AS inbox_id, action, target,
              metadata->>'result' AS result, at
       FROM audit_events
       WHERE action IN ('supervisor.tool', 'supervisor.tool_unknown',
                        'supervisor.unverified_claim', 'supervisor.route')
         AND metadata->>'conversation_id' = $1
       ORDER BY at`,
      [id],
    );

    const byInbox = new Map<
      string,
      { name: string; result: string | null; failed: boolean; kind: string }[]
    >();
    for (const t of tools.rows) {
      if (!t.inbox_id) continue;
      const list = byInbox.get(t.inbox_id) ?? [];
      if (t.action === "supervisor.route") {
        // Which model answered. On a degraded free tier the fallback often
        // serves, and an operator should not have to read the audit log to
        // find that out.
        //
        // A tool-calling turn makes two provider round-trips and so logs this
        // twice. "Which model answered" is one fact, so the same route is shown
        // once — but a turn genuinely served by two different models still shows
        // both, because that is a different fact worth seeing.
        const name = t.target ?? "unknown";
        if (list.some((x) => x.kind === "route" && x.name === name)) continue;
        list.push({ name, result: null, failed: false, kind: "route" });
      } else if (t.action === "supervisor.unverified_claim") {
        // Shown so the turn reads as unconfirmed rather than done.
        list.push({ name: "claimed, no tool ran", result: null, failed: false, kind: "unverified" });
      } else {
        list.push({
          name: t.target ?? "unknown",
          result: t.result,
          failed: t.action === "supervisor.tool_unknown",
          kind: t.action === "supervisor.tool_unknown" ? "unknown" : "ran",
        });
      }
      byInbox.set(t.inbox_id, list);
    }

    return {
      messages: r.rows.map((m) => ({
        ...m,
        tools: m.inbox_event_id ? (byInbox.get(m.inbox_event_id) ?? []) : [],
      })),
    };
  });

  app.post("/api/conversations/:id/messages", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const origin = req.headers.origin;
    if (origin && origin !== (process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com")) {
      return reply.code(403).send({ error: "bad origin" });
    }
    const id = (req.params as { id: string }).id;
    const body = ((req.body ?? {}) as { body?: string }).body ?? "";
    const result = await ingestUserMessage(pool, { conversationId: id, body });
    // SUPERVISOR.md: SSE conversation.message after each assistant message. This
    // only fired on the /api/inbox path, not the one the console posts to.
    sseBroadcast("conversation.message", { conversation_id: id });
    // The first message names the thread. Returning the name saves the client a
    // round trip to find out what the thread it is already looking at is called.
    const named = await pool.query<{ title: string | null }>(
      "SELECT title FROM conversations WHERE id = $1",
      [id],
    );
    const title = named.rows[0]?.title ?? null;
    if (result.error) {
      return reply.code(502).send({ inbox_id: result.inboxId, error: result.error, title });
    }
    return { inbox_id: result.inboxId, assistant: result.assistant, title };
  });

  app.get("/api/models", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query<{
      provider: string;
      model_id: string;
      role_assignments: string[];
      health: string;
      approval_state: string;
      route_order: number;
      auth_profile_id: string | null;
      endpoint_url: string | null;
      last_checked_at: string | null;
      last_error: string | null;
      open_weights: boolean;
      license: string | null;
      // numeric comes back as a string from pg; the console formats it, and
      // nothing here does arithmetic on it that would silently concatenate.
      input_cost_per_mtok: string | null;
      output_cost_per_mtok: string | null;
      month_spend_usd: string;
      month_calls: string;
      month_input_tokens: string;
      month_output_tokens: string;
    }>(
      `SELECT m.provider, m.model_id, m.role_assignments, m.health, m.approval_state,
              m.route_order, m.auth_profile_id, m.endpoint_url, m.last_checked_at,
              m.last_error, m.open_weights, m.license,
              m.input_cost_per_mtok, m.output_cost_per_mtok,
              coalesce(u.spend_usd, 0)   AS month_spend_usd,
              coalesce(u.calls, 0)       AS month_calls,
              coalesce(u.in_tokens, 0)   AS month_input_tokens,
              coalesce(u.out_tokens, 0)  AS month_output_tokens
       FROM model_registry m
       LEFT JOIN (
         SELECT provider, model_id,
                sum(cost_usd)      AS spend_usd,
                count(*)           AS calls,
                sum(input_tokens)  AS in_tokens,
                sum(output_tokens) AS out_tokens
         FROM model_usage
         WHERE at >= date_trunc('month', now())
         GROUP BY provider, model_id
       ) u ON u.provider = m.provider AND u.model_id = m.model_id
       ORDER BY m.route_order, m.provider, m.model_id`,
    );

    // The console shows routing by role, so build the fallback order server-side.
    const roles = [
      "supervisor",
      "utility",
      "senior_engineer",
      "reviewer",
      "stt",
      "voice_tts",
      "vision",
      "embeddings",
    ];
    const byRole = roles.map((role) => ({
      role,
      routes: r.rows
        .filter((m) => (m.role_assignments ?? []).includes(role))
        .sort((a, b) => a.route_order - b.route_order),
    }));
    // Spend and policy, so the console and the Supervisor read the same numbers.
    const totals = await pool.query<{
      spend: string; calls: string; ceiling: string | null;
      open_only: boolean; autonomy: string;
    }>(
      `SELECT coalesce(sum(u.cost_usd), 0)::text AS spend,
              count(u.*)::text                   AS calls,
              p.monthly_ceiling_usd::text        AS ceiling,
              p.open_weights_only                AS open_only,
              p.autonomy                         AS autonomy
       FROM model_policy p
       LEFT JOIN model_usage u ON u.at >= date_trunc('month', now())
       GROUP BY p.monthly_ceiling_usd, p.open_weights_only, p.autonomy`,
    );
    const t = totals.rows[0];

    return {
      models: r.rows,
      roles: byRole,
      spend: {
        month_to_date_usd: Number(t?.spend ?? 0),
        calls: Number(t?.calls ?? 0),
        ceiling_usd: t?.ceiling == null ? null : Number(t.ceiling),
        // Unpriced routes are reported, never assumed free.
        unpriced_routes: r.rows.filter(
          (m) => m.approval_state === "approved" && m.input_cost_per_mtok == null,
        ).length,
      },
      policy: {
        open_weights_only: t?.open_only ?? false,
        autonomy: t?.autonomy ?? "propose",
      },
    };
  });

  app.get("/api/connections", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT c.slug, c.kind, c.scope, c.health, c.last_tested_at,
              a.id AS auth_profile_id, a.display_name, a.auth_type, a.provider,
              a.health AS profile_health, a.metered_spend_allowed,
              (COALESCE(c.credential_id, a.credential_id) IS NOT NULL) AS has_credential,
              cred.fingerprint,
              p.slug AS project_slug, p.name AS project_name
       FROM connections c
       LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id
       LEFT JOIN credentials cred ON cred.id = COALESCE(c.credential_id, a.credential_id)
       LEFT JOIN projects p ON p.id = c.project_id

       UNION ALL

       -- Subscription logins live in auth_profiles and have no connections
       -- row, so they never reached this endpoint - and the page has a branch
       -- written specifically for them (completed with the provider's CLI on
       -- the VPS) that could never render. The host session IS the credential
       -- here, so harness_auth_dir is what counts as connected.
       SELECT a.id AS slug, 'harness' AS kind, 'system' AS scope, a.health,
              NULL::timestamptz AS last_tested_at,
              a.id AS auth_profile_id, a.display_name, a.auth_type, a.provider,
              a.health AS profile_health, a.metered_spend_allowed,
              (a.harness_auth_dir IS NOT NULL) AS has_credential,
              NULL::text AS fingerprint,
              NULL::text AS project_slug, NULL::text AS project_name
       FROM auth_profiles a
       WHERE a.auth_type = 'subscription_login'
         AND NOT EXISTS (SELECT 1 FROM connections c2 WHERE c2.auth_profile_id = a.id)

       ORDER BY scope, slug`,
    );
    return { connections: r.rows };
  });

  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host, port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
