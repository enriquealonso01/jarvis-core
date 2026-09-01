import type pg from "pg";
import { quickCompletion } from "./supervisor.js";
import { createTask, resolveProject } from "./work.js";

/**
 * Deciding what Enrique meant (plan S3a, S3b).
 *
 * `task_create` gave Jarvis the ability to make work. This is the judgement
 * about when to make it, where it belongs, and what to do instead when it is
 * not work at all. Two failures are equally bad and only one of them is
 * obvious: never creating a task, and creating one for "remember the client
 * prefers Tuesdays".
 *
 * One model call does both classification and segmentation, because they are
 * one question. A five-minute voice note that names two projects and a
 * reminder is not one message with a category; it is three destinations, and a
 * classifier that returns a single verdict for it has already lost two thirds
 * of what he said.
 *
 * The decision is persisted on the inbox event before anything acts on it.
 * Wrong routing is invisible otherwise, and the documented way to find the bug
 * is to read a day of verdicts.
 */

export const CATEGORIES = ["capture", "question", "work", "instruction", "ambiguous"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Segment = {
  category: Category;
  /** What the model believes this segment is about; a slug, a name, or null. */
  project: string | null;
  /** The part of the message this segment covers, in his words. */
  text: string;
  /** A title only when the segment is work. */
  title?: string | null;
  /** What done looks like; only when the segment is work. */
  objective?: string | null;
  /** Why this category. Read back in bulk when a route goes wrong. */
  reason: string;
};

export type RouteDecision = {
  segments: Segment[];
  /** 'mixed' when the segments disagree - the summary verdict for the event. */
  category: Category | "mixed";
  reason: string;
  model: string;
  /**
   * Did a router actually answer with something usable?
   *
   * "The router said it cannot tell" and "there is no router" both come out as
   * `ambiguous`, and they must not be treated the same. The first is a decision
   * and is answered with one short question; the second is degradation, and the
   * message falls through to the Supervisor exactly as it did before S3.
   */
  available: boolean;
};

/** The marker the fake model keys on, and a reminder that this prompt is not the Supervisor's. */
export const ROUTE_CLASSIFIER_MARKER = "ROUTE CLASSIFIER";

function systemPrompt(projects: { slug: string; name: string }[]): string {
  const known = projects.map((p) => `- ${p.slug} (${p.name})`).join("\n") || "(none)";
  return [
    `${ROUTE_CLASSIFIER_MARKER}. You are the router for Enrique's assistant, Jarvis.`,
    "",
    "Split his message into segments and give each one a category. Reply with JSON only -",
    "no prose, no markdown fence. Shape:",
    "",
    '{"segments":[{"category":"...","project":"...|null","text":"...","title":"...|null",'
      + '"objective":"...|null","reason":"..."}],"reason":"..."}',
    "",
    "Categories:",
    "- capture      something to REMEMBER. A preference, a fact, a decision.",
    "- question     something to ANSWER now.",
    "- work         something to DO. Code changed, a bug fixed, a PR opened, data gathered.",
    "- instruction  a change to how Jarvis BEHAVES from now on.",
    "- ambiguous    you cannot tell, or you cannot tell which project it belongs to.",
    "",
    "Rules:",
    "- One segment per distinct destination. A message naming two projects and a reminder is THREE segments.",
    "- Do not invent a project. If the project he names is not in the list below, the segment is",
    "  ambiguous and its reason says which name he used.",
    "- Only a 'work' segment gets a title and an objective. The objective says what done looks like,",
    "  written for someone who cannot see this conversation - never a copy of his words.",
    "- Over-creating work is as wrong as creating none. If he is telling you something rather than",
    "  asking for it, that is capture, not work.",
    "- Keep 'text' close to his own wording for that segment.",
    "",
    "Projects that exist:",
    known,
  ].join("\n");
}

/**
 * Pull the JSON out of whatever the model actually returned.
 *
 * Models fence JSON, prefix it with "Here is", and occasionally emit a bare
 * array. All three are recoverable and none of them should cost the message.
 */
function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to a bracket scan */
  }
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Turn whatever came back into segments we are willing to act on.
 *
 * A malformed reply must not become a silent "work" - that is the direction
 * this fails badly in. Anything unrecognised becomes `ambiguous`, which asks
 * rather than acts.
 */
export function parseDecision(
  raw: string,
  fallbackText: string,
): Omit<RouteDecision, "model"> {
  const parsed = extractJson(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { segments?: unknown } | null)?.segments)
      ? (parsed as { segments: unknown[] }).segments
      : null;
  const topReason = str((parsed as { reason?: unknown } | null)?.reason) ?? "";

  if (!list || list.length === 0) {
    return {
      segments: [
        {
          category: "ambiguous",
          project: null,
          text: fallbackText,
          reason: "the router did not return usable segments",
        },
      ],
      category: "ambiguous",
      reason: topReason || "unparseable router reply",
      available: false,
    };
  }

  const segments: Segment[] = list.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const rawCategory = (str(e.category) ?? "").toLowerCase();
    const category = (CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as Category)
      : "ambiguous";
    return {
      category,
      project: str(e.project),
      text: str(e.text) ?? fallbackText,
      title: category === "work" ? str(e.title) : null,
      objective: category === "work" ? str(e.objective) : null,
      reason:
        str(e.reason)
        ?? (category === "ambiguous" ? "no category returned; treated as ambiguous" : ""),
    };
  });

  const distinct = new Set(segments.map((s) => s.category));
  const category = distinct.size === 1 ? ([...distinct][0] as Category) : "mixed";
  return { segments, category, reason: topReason, available: true };
}

/**
 * Classify one inbox event and write the verdict to it.
 *
 * Never throws. The message is already durable by the time this runs, and a
 * router that could take the turn down with it would make classification a new
 * way to lose input - exactly what persist-first exists to prevent. A failure
 * is recorded as `ambiguous`, which asks Enrique instead of guessing.
 */
export async function classifyInbox(
  pool: pg.Pool,
  args: { inboxId: string; text: string },
): Promise<RouteDecision> {
  const projects = await pool.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM projects
     WHERE archived_at IS NULL AND is_system = false ORDER BY slug`,
  );

  const unavailable = (reason: string, model: string): RouteDecision => ({
    segments: [{ category: "ambiguous", project: null, text: args.text, reason }],
    category: "ambiguous",
    reason,
    model,
    available: false,
  });

  let decision: RouteDecision;
  try {
    const raw = await quickCompletion(pool, systemPrompt(projects.rows), args.text, {
      maxTokens: 1200,
    });
    decision = raw
      ? { ...parseDecision(raw, args.text), model: "router" }
      : unavailable("no model route answered the router", "none");
  } catch (err) {
    decision = unavailable(
      `router failed: ${err instanceof Error ? err.message : String(err)}`,
      "none",
    );
  }

  await pool
    .query(
      `UPDATE inbox_events
       SET route_category = $2,
           route_segments = $3,
           route_decided_at = now(),
           route_model = $4,
           routing_note = COALESCE($5, routing_note),
           processing_state = CASE WHEN processing_state = 'pending' THEN 'classified'
                                   ELSE processing_state END
       WHERE id = $1`,
      [
        args.inboxId,
        decision.category,
        JSON.stringify(decision.segments),
        decision.model,
        decision.reason.slice(0, 1000) || null,
      ],
    )
    .catch(() => undefined);

  return decision;
}

/** What one segment actually became, so the reply can say so and a test can assert it. */
export type Destination = {
  category: Category;
  projectSlug: string | null;
  conversationId: string | null;
  taskId: string | null;
  memoryId: string | null;
  /** Set when the segment could not be acted on; becomes the one short question. */
  question: string | null;
  summary: string;
};

export type RouteOutcome = {
  destinations: Destination[];
  /** Segments that need the Supervisor to answer them rather than file them. */
  questions: string[];
  /** True when nothing was actionable and the Supervisor should handle the message as before. */
  passthrough: boolean;
};

/**
 * A thread for this project to hang the work off.
 *
 * Reuses the project's existing thread when it has one - a memo about Alpha Web
 * belongs in the Alpha Web conversation, not in a new thread every time he
 * mentions it. A thread created here records the inbox event it came from, so
 * the trail back to the original message survives even though the message
 * itself never moves.
 */
async function threadForProject(
  pool: pg.Pool,
  projectId: string,
  slug: string,
  inboxId: string,
): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE project_id = $1 ORDER BY last_activity_at DESC LIMIT 1`,
    [projectId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel, created_from_inbox_id)
     VALUES ($1, $2, 'web', $3) RETURNING id`,
    [projectId, slug, inboxId],
  );
  return created.rows[0].id;
}

/**
 * Execute a route decision (plan S3b).
 *
 * The source is never moved and never edited. Every destination points back at
 * the original inbox event, so a three-way split leaves one message and three
 * things that know where they came from - "splitting never destroys the
 * source".
 *
 * Nothing here guesses. A work segment naming a project that does not resolve
 * becomes a question, not a task on the nearest match.
 */
export async function applyRoute(
  pool: pg.Pool,
  args: { inboxId: string; sourceConversationId: string; decision: RouteDecision },
): Promise<RouteOutcome> {
  const { decision } = args;

  // No router, or a reply we could not read: this is degradation, not a
  // decision. Hand the message to the Supervisor exactly as before S3 rather
  // than inventing a verdict for it.
  if (!decision.available) {
    return { destinations: [], questions: [], passthrough: true };
  }

  const destinations: Destination[] = [];
  const questions: string[] = [];

  const unclear = (question: string, summary: string): Destination => ({
    category: "ambiguous",
    projectSlug: null,
    conversationId: null,
    taskId: null,
    memoryId: null,
    question,
    summary,
  });

  for (const segment of decision.segments) {
    if (segment.category === "question") {
      questions.push(segment.text);
      destinations.push({
        category: "question",
        projectSlug: null,
        conversationId: args.sourceConversationId,
        taskId: null,
        memoryId: null,
        question: null,
        summary: "answered here",
      });
      continue;
    }

    if (segment.category === "ambiguous") {
      destinations.push(
        unclear(
          segment.reason || "I could not tell what this was about.",
          `asked about: ${segment.text.slice(0, 60)}`,
        ),
      );
      continue;
    }

    // Everything below wants a project when the segment named one. An
    // unresolvable name is a question, never a best guess.
    let projectId: string | null = null;
    let slug: string | null = null;
    if (segment.project) {
      const resolved = await resolveProject(pool, segment.project);
      if ("error" in resolved) {
        destinations.push(unclear(resolved.error, `could not place: ${segment.text.slice(0, 60)}`));
        continue;
      }
      projectId = resolved.id;
      slug = resolved.slug;
    }

    if (segment.category === "capture") {
      const stored = await pool.query<{ id: string }>(
        `INSERT INTO memory_items (project_id, kind, body, source_inbox_id)
         VALUES ($1, 'note', $2, $3) RETURNING id`,
        [projectId, segment.text, args.inboxId],
      );
      destinations.push({
        category: "capture",
        projectSlug: slug,
        conversationId: null,
        taskId: null,
        memoryId: stored.rows[0].id,
        question: null,
        summary: `remembered: ${segment.text.slice(0, 60)}`,
      });
      continue;
    }

    if (segment.category === "instruction") {
      // A change to how Jarvis behaves is work on Jarvis, filed against the
      // Improvement project on the system lane. S24 turns these into real config
      // versions; until then the record of the request is what matters.
      const sys = await pool.query<{ id: string }>(
        `SELECT id FROM projects WHERE slug = 'jarvis-improvement'`,
      );
      const target = sys.rows[0]?.id ?? null;
      const conversationId = target
        ? await threadForProject(pool, target, "jarvis-improvement", args.inboxId)
        : args.sourceConversationId;
      const taskId = await createTask(pool, {
        projectId: target,
        conversationId,
        originInboxId: args.inboxId,
        title: (segment.title ?? segment.text).slice(0, 200),
        objective:
          segment.objective
          ?? `Standing instruction from Enrique: ${segment.text}. Apply it from now on and record it in configuration.`,
        lane: "system",
        priority: "normal",
        cause: "route:instruction",
      });
      destinations.push({
        category: "instruction",
        projectSlug: "jarvis-improvement",
        conversationId,
        taskId,
        memoryId: null,
        question: null,
        summary: `config task: ${segment.text.slice(0, 60)}`,
      });
      continue;
    }

    // work
    if (!projectId || !slug) {
      destinations.push(
        unclear(`Which project is this for? "${segment.text.slice(0, 80)}"`, "work with no project"),
      );
      continue;
    }
    const conversationId = await threadForProject(pool, projectId, slug, args.inboxId);
    const taskId = await createTask(pool, {
      projectId,
      conversationId,
      originInboxId: args.inboxId,
      title: (segment.title ?? segment.text).slice(0, 200),
      objective: segment.objective ?? segment.text,
      lane: "heavy",
      priority: "normal",
      cause: "route:work",
    });
    destinations.push({
      category: "work",
      projectSlug: slug,
      conversationId,
      taskId,
      memoryId: null,
      question: null,
      summary: `task in ${slug}: ${(segment.title ?? segment.text).slice(0, 60)}`,
    });
  }

  await pool
    .query(`UPDATE inbox_events SET processing_state = 'routed' WHERE id = $1`, [args.inboxId])
    .catch(() => undefined);

  return { destinations, questions, passthrough: false };
}

/**
 * What to say back.
 *
 * One line per destination so he can see the split happened, and at most ONE
 * question however many segments were unclear - the plan is explicit that
 * ambiguity produces one short question, not a list of them.
 */
export function summariseRoute(outcome: RouteOutcome): string {
  const acted = outcome.destinations.filter((d) => !d.question && d.category !== "question");
  const unclear = outcome.destinations.filter((d) => d.question);
  const blocks: string[] = [];
  if (acted.length) blocks.push(acted.map((d) => `- ${d.summary}`).join("\n"));
  if (unclear.length === 1) {
    blocks.push(unclear[0].question as string);
  } else if (unclear.length > 1) {
    blocks.push(
      `${unclear[0].question as string} (${unclear.length - 1} other part of that message needs placing too.)`,
    );
  }
  return blocks.join("\n\n");
}
