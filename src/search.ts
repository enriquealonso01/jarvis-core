import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";

/**
 * Global search, the activity feed, and the resource trend (plan S18).
 *
 * "By this point Jarvis holds months of conversations, tasks, issues, artifacts
 * and memories, and the only way to reach any of it is to know which page it
 * lives on. That is the point at which a console stops being usable."
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * PROJECT SCOPING IS ENFORCED IN THE QUERY, not in the caller and not in the
 * page. The plan is explicit that "search scoped to project A never returns
 * project B's content" is an ISOLATION test, not a UX one, and it stops other
 * work if it fails. So every source below takes the same `project_id` bind and
 * a source that cannot be scoped is not searched at all when a scope is given.
 *
 * RANKING IS PER KIND. The plan: "If results are dominated by one kind, ranking
 * is comparing incomparable scores across sources — normalise per kind before
 * merging, or group and rank within groups rather than pretending one global
 * ordering is meaningful." So results are grouped and ordered within a group,
 * and no cross-source score is ever invented.
 */

type Hit = {
  kind: string;
  id: string;
  title: string;
  snippet: string | null;
  href: string;
  project_slug: string | null;
  at: string | null;
};

/** A window of text around the match, so a hit shows why it is a hit. */
function snippet(body: string | null, q: string, width = 160): string | null {
  if (!body) return null;
  const i = body.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return body.slice(0, width);
  const start = Math.max(0, i - Math.floor(width / 3));
  return (start > 0 ? "…" : "") + body.slice(start, start + width) + (start + width < body.length ? "…" : "");
}

export function registerSearchRoutes(app: FastifyInstance, pool: pg.Pool) {
  /**
   * Ask a question, rather than search for a string (plan S30).
   *
   * Deliberately a different route from `/api/search`, which finds things by
   * substring and orders them by recency - that is the right shape for "where
   * is that task" and the wrong one for "what did the client say about the
   * refund window". This one ranks by relevance, keeps the tiers apart, cites
   * what it found, and says plainly when it found nothing.
   *
   * The honest no is the reason this is a route at all rather than a flag on
   * the existing one: a caller that gets `known: false` cannot accidentally
   * render a confident answer, because there is nothing to render.
   */
  app.get("/api/ask", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const q = ((req.query as { q?: string }).q ?? "").trim();
    const projectId = (req.query as { project_id?: string }).project_id ?? null;
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 5) || 5, 1), 20);

    if (q.length < 2) {
      return { query: q, known: false, reason: "type at least two characters", searched: [] };
    }

    const { answerFrom, retrieve } = await import("./knowledge.js");
    const found = await retrieve(pool, { q, projectId, limit });
    const answer = answerFrom(found, ["activity", "knowledge", "project_memory", "global_memory"]);

    if (!answer.known) {
      return { query: q, known: false, reason: answer.reason, searched: answer.searched, tiers: [] };
    }
    return {
      query: q,
      known: true,
      citations: answer.citations,
      // Tiers stay separate all the way to the caller: flattening them here
      // would undo the whole point one layer from the screen.
      tiers: found.tiers,
      total: found.total,
    };
  });

  app.get("/api/search", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const q = ((req.query as { q?: string }).q ?? "").trim();
    const scope = (req.query as { project_id?: string }).project_id ?? null;
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 10) || 10, 1), 50);

    if (q.length < 2) {
      return { query: q, groups: [], total: 0, note: "type at least two characters" };
    }
    const like = `%${q}%`;
    const groups: { kind: string; label: string; hits: Hit[] }[] = [];
    const add = (kind: string, label: string, hits: Hit[]) => {
      if (hits.length) groups.push({ kind, label, hits });
    };

    // --- projects ---------------------------------------------------------
    // A scoped search returns at most the project it is scoped to; searching
    // "everything inside project A" must not surface project B's name.
    const projects = await pool.query<Hit>(
      `SELECT 'project' AS kind, id::text AS id, name AS title,
              slug AS snippet, '/projects/detail/?slug=' || slug AS href,
              slug AS project_slug, created_at::text AS at
       FROM projects
       WHERE archived_at IS NULL AND (name ILIKE $1 OR slug ILIKE $1)
         AND ($2::uuid IS NULL OR id = $2)
       ORDER BY name LIMIT $3`,
      [like, scope, limit],
    );
    add("project", "Projects", projects.rows);

    // --- conversations and what was said in them --------------------------
    const conversations = await pool.query<Hit>(
      `SELECT 'conversation' AS kind, c.id::text AS id,
              COALESCE(c.title, 'Untitled thread') AS title,
              NULL AS snippet, '/conversations/?id=' || c.id AS href,
              p.slug AS project_slug, c.last_activity_at::text AS at
       FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
       WHERE c.title ILIKE $1 AND ($2::uuid IS NULL OR c.project_id = $2)
       ORDER BY c.last_activity_at DESC NULLS LAST LIMIT $3`,
      [like, scope, limit],
    );
    add("conversation", "Threads", conversations.rows);

    const messages = await pool.query<Hit & { body: string }>(
      `SELECT 'message' AS kind, m.id::text AS id,
              COALESCE(c.title, 'Untitled thread') AS title, m.body,
              '/conversations/?id=' || m.conversation_id AS href,
              p.slug AS project_slug, m.created_at::text AS at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE m.body ILIKE $1 AND ($2::uuid IS NULL OR c.project_id = $2)
       ORDER BY m.created_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("message", "Messages", messages.rows.map((r) => ({ ...r, snippet: snippet(r.body, q) })));

    // --- work -------------------------------------------------------------
    const tasks = await pool.query<Hit & { objective: string | null }>(
      `SELECT 'task' AS kind, t.id::text AS id, t.title, t.objective,
              '/work/?task=' || t.id AS href, p.slug AS project_slug,
              t.updated_at::text AS at
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE (t.title ILIKE $1 OR t.objective ILIKE $1)
         AND ($2::uuid IS NULL OR t.project_id = $2)
       ORDER BY t.updated_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("task", "Work", tasks.rows.map((r) => ({ ...r, snippet: snippet(r.objective, q) })));

    // Pull requests live on the task that opened them.
    const prs = await pool.query<Hit>(
      `SELECT 'pull_request' AS kind, t.id::text AS id,
              'PR #' || t.pr_number || ' — ' || t.title AS title,
              t.pr_url AS snippet, t.pr_url AS href,
              p.slug AS project_slug, t.updated_at::text AS at
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.pr_url IS NOT NULL
         AND (t.title ILIKE $1 OR t.pr_url ILIKE $1)
         AND ($2::uuid IS NULL OR t.project_id = $2)
       ORDER BY t.updated_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("pull_request", "Pull requests", prs.rows);

    // --- issues -----------------------------------------------------------
    const issues = await pool.query<Hit & { required_action: string | null }>(
      `SELECT 'issue' AS kind, i.id::text AS id, i.title, i.required_action,
              '/issues/?id=' || i.id AS href, p.slug AS project_slug,
              i.last_seen_at::text AS at
       FROM issues i LEFT JOIN projects p ON p.id = i.project_id
       WHERE (i.title ILIKE $1 OR i.required_action ILIKE $1 OR i.category ILIKE $1)
         AND ($2::uuid IS NULL OR i.project_id = $2)
       ORDER BY i.last_seen_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("issue", "Issues", issues.rows.map((r) => ({ ...r, snippet: snippet(r.required_action, q) })));

    // --- artifacts, and the text extracted from them ----------------------
    const artifacts = await pool.query<Hit>(
      `SELECT 'artifact' AS kind, a.id::text AS id, a.path AS title,
              a.artifact_type AS snippet, '/artifacts/?id=' || a.id AS href,
              p.slug AS project_slug, a.created_at::text AS at
       FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.path ILIKE $1 AND ($2::uuid IS NULL OR a.project_id = $2)
       ORDER BY a.created_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("artifact", "Files", artifacts.rows);

    /*
     * The inside of documents.
     *
     * `knowledge_chunks` is the retrieval table S28 fills when it extracts text
     * from what gets dumped in. Searching it here is what makes the plan's
     * Done when possible — "a phrase inside a document dumped three months ago
     * is findable in one search" — and it is the same path S28 will write to,
     * not a second one that would have to be kept in step.
     */
    const chunks = await pool.query<Hit & { body: string }>(
      `SELECT 'document' AS kind, k.id::text AS id,
              COALESCE(a.path, 'dumped document') AS title, k.body,
              CASE WHEN a.id IS NOT NULL THEN '/artifacts/?id=' || a.id ELSE '/inbox/' END AS href,
              p.slug AS project_slug, k.created_at::text AS at
       FROM knowledge_chunks k
       LEFT JOIN artifacts a ON a.id = k.source_artifact_id
       LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.body ILIKE $1 AND ($2::uuid IS NULL OR k.project_id = $2)
       ORDER BY k.created_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("document", "Inside documents", chunks.rows.map((r) => ({ ...r, snippet: snippet(r.body, q) })));

    // --- memories ---------------------------------------------------------
    const memories = await pool.query<Hit & { body: string }>(
      `SELECT 'memory' AS kind, m.id::text AS id, m.kind AS title, m.body,
              '/settings/' AS href, p.slug AS project_slug, m.created_at::text AS at
       FROM memory_items m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.body ILIKE $1 AND ($2::uuid IS NULL OR m.project_id = $2)
       ORDER BY m.created_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("memory", "Memory", memories.rows.map((r) => ({ ...r, snippet: snippet(r.body, q) })));

    // --- captured input ---------------------------------------------------
    const inbox = await pool.query<Hit & { raw_text: string }>(
      `SELECT 'inbox' AS kind, i.id::text AS id,
              COALESCE(i.channel, 'capture') AS title, i.raw_text,
              '/inbox/?id=' || i.id AS href, p.slug AS project_slug,
              i.received_at::text AS at
       FROM inbox_events i LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.raw_text ILIKE $1 AND ($2::uuid IS NULL OR i.project_id = $2)
       ORDER BY i.received_at DESC LIMIT $3`,
      [like, scope, limit],
    );
    add("inbox", "Captured", inbox.rows.map((r) => ({ ...r, snippet: snippet(r.raw_text, q) })));

    // --- connections and schedules ----------------------------------------
    // Both are system objects. A SCOPED search does not return them unless they
    // belong to the project, which is the same rule as everything above.
    const connections = await pool.query<Hit>(
      `SELECT 'connection' AS kind, c.id::text AS id, c.slug AS title,
              c.kind AS snippet, '/connections/' AS href, p.slug AS project_slug,
              c.created_at::text AS at
       FROM connections c LEFT JOIN projects p ON p.id = c.project_id
       WHERE (c.slug ILIKE $1 OR c.kind ILIKE $1)
         AND ($2::uuid IS NULL OR c.project_id = $2)
       ORDER BY c.slug LIMIT $3`,
      [like, scope, limit],
    );
    add("connection", "Connections", connections.rows);

    const schedules = await pool.query<Hit>(
      `SELECT 'schedule' AS kind, s.id::text AS id, s.name AS title,
              s.cron AS snippet, '/schedules/' AS href, p.slug AS project_slug,
              s.created_at::text AS at
       FROM schedules s LEFT JOIN projects p ON p.id = s.project_id
       WHERE (s.name ILIKE $1 OR s.cron ILIKE $1)
         AND ($2::uuid IS NULL OR s.project_id = $2)
       ORDER BY s.name LIMIT $3`,
      [like, scope, limit],
    );
    add("schedule", "Schedules", schedules.rows);

    const total = groups.reduce((n, g) => n + g.hits.length, 0);
    return {
      query: q,
      scoped_to: scope,
      groups,
      total,
      // Said out loud rather than rendered as an empty list, which reads like a
      // page still loading (S15's rule, and S18 repeats it).
      note: total === 0 ? `Nothing matches "${q}".` : null,
    };
  });

  /** One ordered feed, per project or globally. */
  app.get("/api/activity", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const qq = req.query as { project_id?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(qq.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(qq.offset ?? 0) || 0, 0);
    const scope = qq.project_id ?? null;

    const r = await pool.query(
      `SELECT a.id, a.at, a.kind, a.subject_id, a.title, a.detail, a.actor, a.href,
              p.slug AS project_slug, p.name AS project_name
       FROM activity_events a LEFT JOIN projects p ON p.id = a.project_id
       WHERE ($1::uuid IS NULL OR a.project_id = $1)
       ORDER BY a.at DESC LIMIT $2 OFFSET $3`,
      [scope, limit, offset],
    );
    const total = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activity_events WHERE ($1::uuid IS NULL OR project_id = $1)`,
      [scope],
    );
    return {
      events: r.rows,
      total: Number(total.rows[0].n),
      note: r.rows.length === 0 ? "Nothing has happened here yet." : null,
    };
  });

  /**
   * A slope, not a snapshot.
   *
   * "the console can say 'disk is at 84%' but never 'disk has climbed 9 points
   * this week', and Maintenance cannot act before a threshold rather than after
   * it." Least squares over the window, reported per day so the number reads the
   * way the sentence does.
   */
  app.get("/api/metrics/trend", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const qq = req.query as { metric?: string; hours?: string };
    const COLUMNS: Record<string, string> = {
      disk: "disk_used_pct",
      memory: "memory_used_pct",
      cpu: "cpu_busy_pct",
      load: "load1",
    };
    const column = COLUMNS[qq.metric ?? "disk"];
    if (!column) return reply.code(400).send({ error: "unknown metric" });
    const hours = Math.min(Math.max(Number(qq.hours ?? 168) || 168, 1), 24 * 90);

    const r = await pool.query<{ t: string; v: string }>(
      `SELECT extract(epoch from at)::text AS t, ${column}::text AS v
       FROM resource_metrics
       WHERE at > now() - make_interval(hours => $1) AND ${column} IS NOT NULL
       ORDER BY at`,
      [hours],
    );
    const points = r.rows.map((row) => ({ t: Number(row.t), v: Number(row.v) }));
    if (points.length < 2) {
      // Two points is the minimum that can have a direction. Saying so is more
      // useful than reporting a slope of zero, which would read as "flat".
      return {
        metric: qq.metric ?? "disk",
        samples: points.length,
        slope_per_day: null,
        note: "not enough history to say which way it is going",
      };
    }
    const n = points.length;
    const meanT = points.reduce((s, p) => s + p.t, 0) / n;
    const meanV = points.reduce((s, p) => s + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of points) {
      num += (p.t - meanT) * (p.v - meanV);
      den += (p.t - meanT) ** 2;
    }
    const perSecond = den === 0 ? 0 : num / den;
    return {
      metric: qq.metric ?? "disk",
      samples: n,
      first: points[0],
      last: points[n - 1],
      slope_per_day: Number((perSecond * 86400).toFixed(3)),
      change_over_window: Number((points[n - 1].v - points[0].v).toFixed(2)),
      note: null,
    };
  });
}
