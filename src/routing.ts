import type pg from "pg";
import { quickCompletion } from "./supervisor.js";

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
export function parseDecision(raw: string, fallbackText: string): Omit<RouteDecision, "model"> {
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
  return { segments, category, reason: topReason };
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
