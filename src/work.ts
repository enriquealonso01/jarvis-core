import type pg from "pg";
import { transitionTask } from "./jobs.js";

/**
 * Making work, in one place.
 *
 * Two callers create tasks now: the Supervisor's `task_create` tool (S2), when
 * Enrique asks for something in a thread, and the router (S3), when a segment of
 * a longer message turns out to be work. They must agree about everything that
 * matters — which project, what counts as a real objective, where the provenance
 * comes from — because a task filed by one route and a task filed by the other
 * are the same thing to everyone downstream.
 *
 * This module is deliberately not in supervisor.ts or routing.ts: those two
 * already import each other's neighbourhood, and a shared helper living in
 * either of them is an import cycle waiting to happen.
 */

export const LANES = new Set(["heavy", "system", "supervisor"]);
export const PRIORITIES = new Set(["critical", "high", "normal", "low", "background"]);

/** Loose enough to survive punctuation and case, tight enough to catch an echo. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Resolve what the model called a project into exactly one row, or say why not.
 *
 * Guessing is the expensive failure here: a task filed against the wrong project
 * runs with the wrong credentials, the wrong repo and the wrong confidentiality
 * class. One short question costs a round trip; a wrong project costs an
 * isolation incident.
 */
export async function resolveProject(
  pool: pg.Pool,
  wanted: string,
): Promise<{ id: string; slug: string } | { error: string }> {
  const q = wanted.trim();
  const r = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM projects
     WHERE archived_at IS NULL AND (slug = $1 OR lower(slug) = lower($1) OR lower(name) = lower($1))`,
    [q],
  );
  if (r.rows.length === 1) return r.rows[0];
  if (r.rows.length > 1) {
    return { error: `"${q}" matches ${r.rows.map((p) => p.slug).join(", ")}. Ask which one; do not guess.` };
  }
  const like = await pool.query<{ slug: string }>(
    `SELECT slug FROM projects
     WHERE archived_at IS NULL AND (slug ILIKE $1 OR name ILIKE $1)
     ORDER BY slug LIMIT 5`,
    [`%${q}%`],
  );
  if (like.rows.length === 1) return await resolveProject(pool, like.rows[0].slug);
  if (like.rows.length > 1) {
    return {
      error: `"${q}" is ambiguous: it could be ${like.rows.map((p) => p.slug).join(" or ")}. `
        + "Ask him which one in one short question. No task was created.",
    };
  }
  const all = await pool.query<{ slug: string }>(
    `SELECT slug FROM projects WHERE archived_at IS NULL AND is_system = false ORDER BY slug LIMIT 10`,
  );
  return {
    error: `there is no project called "${q}". Existing projects: `
      + `${all.rows.map((p) => p.slug).join(", ") || "(none yet)"}. Ask him which one. No task was created.`,
  };
}

export async function projectSlug(pool: pg.Pool, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const r = await pool.query<{ slug: string }>(`SELECT slug FROM projects WHERE id = $1`, [projectId]);
  return r.rows[0]?.slug ?? null;
}

/**
 * Create one task and walk it onto the queue.
 *
 * Provenance is a parameter, never something the caller can forget: the pair
 * (conversation, inbox event) is the only link back from a task to the sentence
 * that caused it, and a task without it cannot be explained later.
 */
export async function createTask(
  pool: pg.Pool,
  args: {
    projectId: string | null;
    conversationId: string | null;
    originInboxId: string | null;
    title: string;
    objective: string;
    lane: string;
    priority: string;
    cause: string;
  },
): Promise<string> {
  const lane = LANES.has(args.lane.toLowerCase()) ? args.lane.toLowerCase() : "heavy";
  const priority = PRIORITIES.has(args.priority.toLowerCase()) ? args.priority.toLowerCase() : "normal";
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, conversation_id, origin_inbox_id, title, objective, state, lane, priority)
     VALUES ($1, $2, $3, $4, $5, 'captured', $6, $7)
     RETURNING id`,
    [
      args.projectId,
      args.conversationId,
      args.originInboxId,
      args.title.slice(0, 200),
      args.objective,
      lane,
      priority,
    ],
  );
  const id = inserted.rows[0].id;
  // Walk the documented machine rather than jumping straight to queued, so the
  // Work view has a trail and STATE_MACHINES stays true.
  await transitionTask(pool, id, "classified", args.cause, "supervisor");
  await transitionTask(pool, id, "queued", args.cause, "supervisor");
  return id;
}
