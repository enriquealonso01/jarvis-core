import type pg from "pg";
import { looksConfidential } from "./redaction.js";

/**
 * Stage B — the deterministic router (ADR 005, S12b item 1).
 *
 * "Classification is a pipeline. An LLM is never the first reader of a
 * confidential body." Today it is: every inbound message goes straight to
 * `classifyInbox`, which is a model call, and the body goes with it. That is one
 * of the two gaps S12b lists as LIVE — running, on the box, today.
 *
 * This runs between Stage A (persist) and Stage C (the Supervisor). It decides
 * the project and the conversation from the message itself, with no model, in
 * the order the ADR sets out:
 *
 *   1. an explicit correction stored on the event
 *   2. an in-message directive — `#project-slug`, or a configured alias
 *   3. a reply or thread pointer to an existing conversation
 *   4. the correlation window: same channel, same sender, inside ten minutes
 *   5. a sticky "active project", if set and less than two hours old
 *   6. an allowlisted sender bound to one project (default off)
 *   7. otherwise nothing, which is the global Supervisor conversation
 *
 * What it does NOT do is decide what the message means. That is still Stage C's
 * job. The difference this makes is that by the time a model sees anything, the
 * project is already known — so a confidential one gets `metadata_only`, and a
 * body that looks like code with no project is held rather than sent.
 */

export type RouteBRule =
  | "correction"
  | "directive"
  | "thread"
  | "correlation"
  | "sticky"
  | "sender"
  | "none";

export type RouteB = {
  projectId: string | null;
  projectSlug: string | null;
  conversationId: string | null;
  rule: RouteBRule;
  /** ADR 005: a confidential project's body never reaches the Supervisor. */
  payloadMode: "full" | "metadata_only";
  /** True when the text looks like code, logs or a stack trace. */
  confidential: boolean;
  /** Human-readable, written onto the event so a wrong route can be explained. */
  note: string;
};

/** How long a follow-up counts as part of the same exchange (ADR 005 rule 4). */
const CORRELATION_MS = 10 * 60_000;
/** How long a sticky "active project" stays sticky (rule 5). */
const STICKY_MS = 2 * 60 * 60_000;

/**
 * The `#slug` directive, and only at a word boundary.
 *
 * `#alpha-web` routes; an `#ifdef` in a pasted C file does not, because there is
 * no project called `ifdef` — the slug has to match a real one, which is what
 * stops a hash in a code block from moving a message.
 */
export function directiveSlugs(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9-]{1,60})\b/gi)].map((m) => m[1].toLowerCase());
}

async function projectBySlugOrAlias(
  pool: pg.Pool,
  candidates: string[],
): Promise<{ id: string; slug: string } | null> {
  if (!candidates.length) return null;
  const r = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM projects
     WHERE archived_at IS NULL AND is_system = false AND lower(slug) = ANY($1::text[])
     LIMIT 1`,
    [candidates],
  );
  return r.rows[0] ?? null;
}

/**
 * A conversation for a project, reused rather than multiplied.
 *
 * One project, one routed thread per channel: a directive that opened a fresh
 * conversation every time would turn a day of `#alpha` notes into a day of
 * threads nobody reads.
 */
async function conversationFor(
  pool: pg.Pool,
  projectId: string,
  channel: string,
): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE project_id = $1 AND channel = $2
     ORDER BY last_activity_at DESC LIMIT 1`,
    [projectId, channel],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const made = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel)
     VALUES ($1, (SELECT name FROM projects WHERE id = $1), $2) RETURNING id`,
    [projectId, channel],
  );
  return made.rows[0].id;
}

export async function deterministicRoute(
  pool: pg.Pool,
  args: {
    inboxId: string;
    text: string;
    channel: string;
    sender: string | null;
    /** The conversation the message arrived in, if it arrived in one. */
    conversationId?: string | null;
    /** A reply pointer from the channel, when it has one. */
    inReplyTo?: string | null;
  },
): Promise<RouteB> {
  const confidential = looksConfidential(args.text);
  const decide = async (
    rule: RouteBRule,
    project: { id: string; slug: string } | null,
    conversationId: string | null,
    note: string,
  ): Promise<RouteB> => {
    let mode: "full" | "metadata_only" = "full";
    if (project) {
      const conf = await pool.query<{ confidentiality: string }>(
        "SELECT confidentiality FROM projects WHERE id = $1",
        [project.id],
      );
      if (["confidential", "restricted"].includes(conf.rows[0]?.confidentiality ?? "")) {
        mode = "metadata_only";
      }
    }
    return {
      projectId: project?.id ?? null,
      projectSlug: project?.slug ?? null,
      conversationId,
      rule,
      payloadMode: mode,
      confidential,
      note,
    };
  };

  // ---- 1. an explicit correction, which outranks everything ---------------
  const corrected = await pool
    .query<{ project_id: string; slug: string }>(
      `SELECT o.project_id, p.slug FROM routing_overrides o
       JOIN projects p ON p.id = o.project_id
       WHERE o.inbox_event_id = $1 ORDER BY o.created_at DESC LIMIT 1`,
      [args.inboxId],
    )
    .catch(() => ({ rows: [] as { project_id: string; slug: string }[] }));
  if (corrected.rows[0]) {
    const project = { id: corrected.rows[0].project_id, slug: corrected.rows[0].slug };
    return await decide(
      "correction",
      project,
      await conversationFor(pool, project.id, args.channel),
      `you moved this to ${project.slug}`,
    );
  }

  // ---- 2. #project-slug in the message ------------------------------------
  const named = await projectBySlugOrAlias(pool, directiveSlugs(args.text));
  if (named) {
    return await decide(
      "directive",
      named,
      await conversationFor(pool, named.id, args.channel),
      `you named #${named.slug}`,
    );
  }

  // ---- 3. a reply or thread pointer ---------------------------------------
  const threadId = args.inReplyTo ?? args.conversationId ?? null;
  if (threadId) {
    const thread = await pool
      .query<{ id: string; project_id: string | null; slug: string | null }>(
        `SELECT c.id, c.project_id, p.slug FROM conversations c
         LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
        [threadId],
      )
      .catch(() => ({ rows: [] as { id: string; project_id: string | null; slug: string | null }[] }));
    const t = thread.rows[0];
    if (t?.project_id && t.slug) {
      return await decide(
        "thread",
        { id: t.project_id, slug: t.slug },
        t.id,
        `it is a reply in ${t.slug}'s thread`,
      );
    }
  }

  // ---- 4. the correlation window ------------------------------------------
  if (args.sender) {
    const recent = await pool.query<{ project_id: string; slug: string; conversation_id: string }>(
      `SELECT i.project_id, p.slug, i.conversation_id
       FROM inbox_events i
       JOIN projects p ON p.id = i.project_id
       WHERE i.channel = $1 AND i.sender = $2 AND i.id <> $3
         AND i.received_at > now() - make_interval(secs => $4::int / 1000.0)
         AND p.archived_at IS NULL
       ORDER BY i.received_at DESC LIMIT 1`,
      [args.channel, args.sender, args.inboxId, CORRELATION_MS],
    );
    const r = recent.rows[0];
    /*
     * "...and the new text does not name a different project slug/alias." A
     * message naming another project has already been caught by rule 2, so
     * reaching here means it named none — except when it named one that does
     * not exist, and that must not be swept into the previous project either.
     */
    const namedSomething = directiveSlugs(args.text).length > 0;
    if (r && !namedSomething) {
      return await decide(
        "correlation",
        { id: r.project_id, slug: r.slug },
        r.conversation_id ?? (await conversationFor(pool, r.project_id, args.channel)),
        `it follows your last ${args.channel} message about ${r.slug}, within ten minutes`,
      );
    }
  }

  // ---- 5. a sticky active project -----------------------------------------
  const sticky = await pool
    .query<{ project_id: string; slug: string }>(
      `SELECT s.project_id, p.slug FROM active_project s
       JOIN projects p ON p.id = s.project_id
       WHERE s.set_at > now() - make_interval(secs => $1::int / 1000.0)
         AND p.archived_at IS NULL
       ORDER BY s.set_at DESC LIMIT 1`,
      [STICKY_MS],
    )
    .catch(() => ({ rows: [] as { project_id: string; slug: string }[] }));
  if (sticky.rows[0]) {
    const project = { id: sticky.rows[0].project_id, slug: sticky.rows[0].slug };
    return await decide(
      "sticky",
      project,
      await conversationFor(pool, project.id, args.channel),
      `${project.slug} is your active project`,
    );
  }

  // ---- 6. an allowlisted sender bound to one project (default off) --------
  if (args.sender) {
    const bound = await pool
      .query<{ project_id: string; slug: string }>(
        `SELECT a.project_id, p.slug FROM sender_project_binding a
         JOIN projects p ON p.id = a.project_id
         WHERE a.channel = $1 AND a.sender = $2 AND a.enabled = true
           AND p.archived_at IS NULL LIMIT 1`,
        [args.channel, args.sender],
      )
      .catch(() => ({ rows: [] as { project_id: string; slug: string }[] }));
    if (bound.rows[0]) {
      const project = { id: bound.rows[0].project_id, slug: bound.rows[0].slug };
      return await decide(
        "sender",
        project,
        await conversationFor(pool, project.id, args.channel),
        `${args.sender} is bound to ${project.slug}`,
      );
    }
  }

  // ---- 7. nothing: the global Supervisor conversation ----------------------
  return await decide("none", null, args.conversationId ?? null, "no project could be determined");
}

/**
 * Write Stage B's verdict onto the event before any model runs.
 *
 * The point of the whole exercise: by the time Stage C exists, the project is
 * already decided and recorded, so a confidential body is never what a model
 * reads first.
 */
export async function applyRouteB(pool: pg.Pool, inboxId: string, route: RouteB): Promise<void> {
  await pool.query(
    `UPDATE inbox_events
     SET project_id = COALESCE($2, project_id),
         conversation_id = COALESCE($3, conversation_id),
         supervisor_payload_mode = $4,
         routing_note = $5,
         route_rule = $6
     WHERE id = $1`,
    [
      inboxId,
      route.projectId,
      route.conversationId,
      route.payloadMode,
      `stage B (${route.rule}): ${route.note}`.slice(0, 300),
      route.rule,
    ],
  );
}
