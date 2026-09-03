import type pg from "pg";
import { quickCompletion } from "./supervisor.js";
import { createTask, projectSlug, resolveProject } from "./work.js";

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

const NEWLINE = "\n";

export const CATEGORIES = [
  "capture", "question", "work", "instruction", "create_project", "ambiguous",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Segment = {
  category: Category;
  /** What the model believes this segment is about; a slug, a name, or null. */
  project: string | null;
  /** The part of the message this segment covers, in his words. */
  text: string;
  /**
   * The short id of an existing open task this segment adds to, rather than
   * starting. Only ever one of the ids the router was shown; anything else is
   * ignored, because a hallucinated id would attach his words to a stranger.
   */
  task?: string | null;
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

export type OpenTask = { short: string; title: string; state: string; slug: string | null };

export type PriorTurn = { role: string; body: string };

export function systemPrompt(
  projects: { slug: string; name: string }[],
  openTasks: OpenTask[],
  history: PriorTurn[] = [],
): string {
  const known = projects.map((p) => `- ${p.slug} (${p.name})`).join("\n") || "(none)";
  const open_ = openTasks.length
    ? openTasks
        .map((t) => `- ${t.short} [${t.state}] ${t.title}${t.slug ? " (" + t.slug + ")" : ""}`)
        .join(NEWLINE)
    : "(none)";
  /*
   * What was already said in this conversation.
   *
   * The router used to get the current utterance and nothing else, and on a
   * phone call that is close to useless: he says "a project called Test Project"
   * and two turns later "just use the defaults", and the second sentence on its
   * own has no subject at all. It was classified ambiguous with the reason "no
   * project name is given" - which was true of the sentence and false of the
   * conversation.
   *
   * Only what has already been through this same gate is included, so this adds
   * no new class of content to a model call.
   */
  const said = history.length
    ? history.map((h) => `- ${h.role === "user" ? "Enrique" : "Jarvis"}: ${h.body}`).join(NEWLINE)
    : "(nothing yet - this is the first thing said)";

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
    "- create_project  he wants a NEW project made, or is answering questions about one being made.",
    "- ambiguous    you cannot tell, or you cannot tell which project it belongs to.",
    "",
    "Rules:",
    "- One segment per distinct destination. A message naming two projects and a reminder is THREE segments.",
    "- Do not invent a project. If the project he names is not in the list below, the segment is",
    "  ambiguous and its reason says which name he used. THE ONE EXCEPTION is create_project: a name",
    "  that matches nothing is the normal case there, because the project does not exist yet. Never",
    "  call a request to CREATE something ambiguous merely because it is not in the list.",
    "- \"Create a project called X\", \"set up a new project\", \"make me a repo for X\" are create_project,",
    "  never capture. He is asking for something to be made, not telling you a fact to remember.",
    "  So is an answer to a question you asked while making one - a name, a yes, \"personal\",",
    "  \"just use the defaults\" - when the last thing discussed was creating a project.",
    "- Only a 'work' segment gets a title and an objective. The objective says what done looks like,",
    "  written for someone who cannot see this conversation - never a copy of his words.",
    "- Over-creating work is as wrong as creating none. If he is telling you something rather than",
    "  asking for it, that is capture, not work.",
    "- Keep 'text' close to his own wording for that segment.",
    "",
    "Earlier in this conversation, oldest first. A fragment often only makes sense",
    "against these - a name given three turns ago is still the name he means:",
    said,
    "",
    "Projects that exist:",
    known,
    "",
    "Tasks already open in this thread:",
    open_,
    "",
    "If a segment ADDS to one of those tasks rather than starting new work - a correction, an extra",
    "thing to check, a change of mind about work already under way - set its category to work and",
    "put that task id in a task field. Never put anything there that is not in the list above.",
    "A segment with a task field needs no title and no project; it inherits both from the task.",
  ].join(NEWLINE);
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
      task: category === "work" ? str(e.task) : null,
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
  args: { inboxId: string; text: string; conversationId?: string },
): Promise<RouteDecision> {
  const projects = await pool.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM projects
     WHERE archived_at IS NULL AND is_system = false ORDER BY slug`,
  );

  // What is already under way here. Without this the router cannot tell "also
  // check the CSV export" from "build me a CSV export" — the first adds to a run
  // in flight, the second starts a new one, and only the open tasks in the
  // thread distinguish them.
  const open = await pool.query<OpenTask>(
    `SELECT substring(t.id::text for 8) AS short, t.title, t.state, p.slug
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.state NOT IN ('succeeded', 'failed_terminal', 'cancelled')
       AND ($1::uuid IS NULL OR t.conversation_id = $1
            OR t.conversation_id IN (SELECT id FROM conversations
                                     WHERE project_id = (SELECT project_id FROM conversations WHERE id = $1)
                                       AND project_id IS NOT NULL))
     ORDER BY t.created_at DESC
     LIMIT 10`,
    [args.conversationId ?? null],
  );

  /*
   * The turns before this one. Bounded at eight and truncated per line: the
   * router is a small fast model on the latency path of a phone call, and the
   * point is to recover a name or a subject, not to re-read the conversation.
   */
  const history = args.conversationId
    ? (await pool.query<{ role: string; body: string }>(
        `SELECT role, left(body, 240) AS body FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 8`,
        [args.conversationId],
      )).rows.reverse()
    : [];

  const unavailable = (reason: string, model: string): RouteDecision => ({
    segments: [{ category: "ambiguous", project: null, text: args.text, reason }],
    category: "ambiguous",
    reason,
    model,
    available: false,
  });

  let decision: RouteDecision;
  try {
    const raw = await quickCompletion(pool, systemPrompt(projects.rows, open.rows, history), args.text, {
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
    /*
     * Swallowed on purpose — a routing RECORD must never take a message down.
     * But swallowed silently is how `create_project` verdicts went missing for
     * a day: a CHECK constraint still listing the original five categories
     * rejected every one of them, the message routed correctly anyway, and
     * `route_category` was simply null. Nothing anywhere said so.
     *
     * So it still cannot throw, and it can no longer be quiet.
     */
    .catch((err: unknown) => {
      console.error(
        `route verdict not persisted for ${args.inboxId} (category ${decision.category}):`,
        err instanceof Error ? err.message : String(err),
      );
    });

  return decision;
}

/** What one segment actually became, so the reply can say so and a test can assert it. */
export type Destination = {
  category: Category;
  projectSlug: string | null;
  conversationId: string | null;
  taskId: string | null;
  memoryId: string | null;
  /** Set when the segment was attached to an existing task rather than starting one. */
  contextId: string | null;
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
  args: {
    inboxId: string;
    sourceConversationId: string;
    /** The project this thread belongs to, if any. Beats anything the model names. */
    sourceProjectId?: string | null;
    decision: RouteDecision;
  },
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
    contextId: null,
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
        contextId: null,
        question: null,
        summary: "answered here",
      });
      continue;
    }

    if (segment.category === "ambiguous") {
      /*
       * What he HEARS must be addressed to him.
       *
       * This used to pass `segment.reason` straight through as the question, and
       * `reason` is the classifier's note to itself — its own doc comment says
       * "read back in bulk when a route goes wrong". On a phone call in
       * production that meant Enrique heard, in a butler's voice: "He wants to
       * create a personal project and repository, but no project name is given",
       * "The user asks to create projects named...", "The message is a fragment
       * with no clear subject, project, or intent". The system reasoning about
       * him in the third person, read aloud, three turns running.
       *
       * The reason is still recorded on the destination's summary, where the
       * diagnostics belong. The question is now a question.
       */
      destinations.push(
        unclear(
          questionAboutUnplaced(segment.text),
          `could not place (${segment.reason || "no reason given"}): ${segment.text.slice(0, 60)}`,
        ),
      );
      continue;
    }

    /*
     * S26 lives in the Supervisor's tools, not here. A request to create a
     * project — or an answer to a question asked while creating one — is handed
     * to the desk whole, with `project_onboarding_start/set/finalize` in front
     * of it.
     *
     * Routing it any other way is what broke the first voice attempt: "I want to
     * create a project called Test Project" was filed as something to REMEMBER
     * and answered "remembered: I want to create a project called Test Project",
     * because capture was the closest of the five categories that existed.
     */
    if (segment.category === "create_project") {
      return { destinations: [], questions: [], passthrough: true };
    }

    // S3c: this adds to work already under way rather than starting new work.
    //
    // Nothing is interrupted. The context is written down and the runner picks
    // it up at its next checkpoint - killing a thirty-minute run to hand it a
    // sentence throws away the thirty minutes.
    if (segment.category === "work" && segment.task) {
      const target = await pool.query<{ id: string; state: string; title: string }>(
        `SELECT id, state, title FROM tasks WHERE substring(id::text for 8) = $1 LIMIT 1`,
        [segment.task.trim().toLowerCase()],
      );
      const task = target.rows[0];
      if (!task) {
        // A task id that does not exist is a hallucination, and attaching his
        // words to a stranger is worse than asking.
        destinations.push(
          unclear(
            `Which task did you mean? I could not find one called "${segment.task}".`,
            `unknown task: ${segment.text.slice(0, 60)}`,
          ),
        );
        continue;
      }
      const stored = await pool.query<{ id: string }>(
        `INSERT INTO task_context (task_id, inbox_event_id, conversation_id, body, attached_state)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [task.id, args.inboxId, args.sourceConversationId, segment.text, task.state],
      );
      const finished = ["succeeded", "failed_terminal", "cancelled"].includes(task.state);
      destinations.push({
        category: "work",
        projectSlug: null,
        conversationId: null,
        taskId: task.id,
        memoryId: null,
        contextId: stored.rows[0].id,
        question: null,
        summary: finished
          // The plan's edge case: context that arrives a second after the run
          // ends must land somewhere retrievable, and must say so rather than
          // reading as though it were picked up.
          ? `noted on "${task.title.slice(0, 40)}", which had already finished - it was not acted on`
          : `added to "${task.title.slice(0, 40)}" (${task.state}); it will be picked up at the next checkpoint`,
      });
      continue;
    }

    // Everything below wants a project when the segment named one. An
    // unresolvable name is a question, never a best guess.
    // The conversation's OWN project wins over anything the model names.
    //
    // It is a fact about where this thread lives; the model's answer is an
    // inference from wording. `task_create` has always worked this way, but
    // applyRoute did not, and the consequence was observed live: a message in a
    // thread scoped to one project was filed as work in a DIFFERENT project the
    // router happened to name. Work filed against the wrong project runs with
    // the wrong repository and the wrong credentials, which makes this an
    // isolation problem, not a tidiness one.
    let projectId: string | null = null;
    let slug: string | null = null;
    if (args.sourceProjectId) {
      projectId = args.sourceProjectId;
      slug = await projectSlug(pool, projectId);
    } else if (segment.project) {
      const resolved = await resolveProject(pool, segment.project);
      if ("error" in resolved) {
        destinations.push(unclear(resolved.error, `could not place: ${segment.text.slice(0, 60)}`));
        continue;
      }
      projectId = resolved.id;
      slug = resolved.slug;
    }

    if (segment.category === "capture") {
      /*
       * Through recordStatement rather than a raw insert (S30).
       *
       * Everything captured used to become a note, which meant a standing
       * instruction never replaced the one it contradicted - "from now on use
       * the past tense" sat in the store beside "always use the imperative",
       * and retrieval returned both with nothing to say which was current.
       *
       * It also delivers the half of the rule that is about SAYING so: the
       * summary carries "that replaces what you told me before", at the moment
       * of the replacement, because a preference that changes silently is one he
       * cannot correct.
       */
      const { recordStatement } = await import("./preference.js");
      const outcome = await recordStatement(pool, {
        projectId,
        text: segment.text,
        inboxId: args.inboxId,
      });
      destinations.push({
        category: "capture",
        projectSlug: slug,
        conversationId: null,
        taskId: null,
        memoryId: "id" in outcome ? outcome.id : null,
        contextId: null,
        question: null,
        summary: outcome.action === "stored" && outcome.replaced.length
          ? outcome.note
          : `remembered: ${segment.text.slice(0, 60)}`,
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
        contextId: null,
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
      contextId: null,
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
/**
 * A question for him about something we could not place.
 *
 * Quotes his own words back rather than describing them, so the reply is usable
 * whether it is read on a screen or heard on a phone. Short on purpose: this is
 * spoken aloud, and a paragraph read by a text-to-speech voice is worse than a
 * sentence.
 *
 * Exported so a test can assert on it directly. What it must never contain is
 * anything ABOUT him — see the ambiguous branch in `applyRoute`.
 */
export function questionAboutUnplaced(text: string): string {
  const words = (text ?? "").trim().replace(/\s+/g, " ");
  if (!words) return "Sorry, I did not catch that. What would you like me to do?";
  const quoted = words.length > 70 ? `${words.slice(0, 70)}…` : words;
  return `Sorry — what would you like me to do about "${quoted}"?`;
}

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
