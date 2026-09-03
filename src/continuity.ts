/**
 * One conversation, whichever surface he used (plan S39).
 *
 *   "A task started on one channel continues on another with its state intact.
 *    **He should never restate what he was doing because he switched
 *    surfaces.** The task, its conversation and its context are the same
 *    objects regardless of which channel touched them."
 *
 * The Debug note names the failure and its cause in one sentence: "If context
 * is lost across channels, look for a **per-channel conversation being created
 * rather than the existing one being joined** — that is the same 1:1 modelling
 * mistake IV.0 warns about, arriving by a different route."
 *
 * So the channel is deliberately NOT part of the lookup key, and that absence is
 * the entire design. It is also the thing a later edit will want to add back,
 * because "find his WhatsApp conversation" is such a natural way to phrase the
 * query — and the moment it is added, the phone and WhatsApp have separate
 * memories of the same request and he starts repeating himself.
 *
 * What DOES key the lookup: the project, and recency. A project because
 * continuity must never reach across an isolation boundary, and recency because
 * a thread has to end eventually or every message he ever sends joins one
 * conversation that began in March.
 */
import type pg from "pg";

/**
 * How long a thread stays open to being continued.
 *
 * Long enough to cover "started it on the drive home, finished it at the desk";
 * short enough that tomorrow's unrelated request is not appended to it. A
 * conversation is a working context, not a filing cabinet.
 */
export const CONTINUITY_WINDOW_MINUTES = 6 * 60;

export type Resolution = {
  conversationId: string;
  /** joined an existing thread, or started a new one. */
  outcome: "joined" | "created";
  why: string;
};

/**
 * Which conversation does this message belong to?
 *
 * `explicitConversationId` wins whenever it is given - the console opening a
 * named thread, a reply to a specific message - because an explicit choice is
 * not a heuristic to be second-guessed.
 */
export async function resolveConversation(
  pool: pg.Pool,
  args: {
    channel: string;
    projectId: string | null;
    explicitConversationId?: string | null;
    title?: string;
    now?: Date;
    windowMinutes?: number;
  },
): Promise<Resolution> {
  const now = args.now ?? new Date();
  const windowMinutes = args.windowMinutes ?? CONTINUITY_WINDOW_MINUTES;

  if (args.explicitConversationId) {
    await touch(pool, args.explicitConversationId, args.channel, now);
    return {
      conversationId: args.explicitConversationId,
      outcome: "joined",
      why: "he named the thread",
    };
  }

  /*
   * No channel in this query, on purpose. See the header: adding one is how the
   * phone and WhatsApp end up with separate memories of the same request.
   *
   * The project comparison uses IS NOT DISTINCT FROM so that the global thread
   * (project_id NULL) continues with itself rather than matching every project
   * or none - a plain `=` makes NULL match nothing and quietly creates a new
   * global conversation for every message.
   */
  const recent = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE project_id IS NOT DISTINCT FROM $1
        AND last_activity_at > $2::timestamptz - ($3 || ' minutes')::interval
      ORDER BY last_activity_at DESC
      LIMIT 1`,
    [args.projectId, now.toISOString(), String(windowMinutes)],
  );

  if (recent.rows[0]) {
    await touch(pool, recent.rows[0].id, args.channel, now);
    return {
      conversationId: recent.rows[0].id,
      outcome: "joined",
      why: `continuing the thread he was in, which ${args.channel} is simply the latest surface for`,
    };
  }

  const created = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel, channels, last_activity_at)
     VALUES ($1, $2, $3, ARRAY[$3], $4) RETURNING id`,
    [args.projectId, args.title ?? "New thread", args.channel, now],
  );
  return {
    conversationId: created.rows[0].id,
    outcome: "created",
    why: "nothing recent to continue",
  };
}

/**
 * Record that a surface touched this thread.
 *
 * The channel is appended rather than overwritten: `conversations.channel`
 * still means "where it started", and losing that would make a thread look as
 * though it had always been a console thread the moment he opened it there.
 */
export async function touch(
  pool: pg.Pool,
  conversationId: string,
  channel: string,
  now = new Date(),
): Promise<void> {
  await pool.query(
    `UPDATE conversations
        SET last_activity_at = $3,
            channels = CASE WHEN $2 = ANY(channels) THEN channels ELSE array_append(channels, $2) END
      WHERE id = $1`,
    [conversationId, channel, now],
  );
}

/** Every surface that has touched this thread, for the console and for tests. */
export async function channelsOf(pool: pg.Pool, conversationId: string): Promise<string[]> {
  const r = await pool.query<{ channels: string[] }>(
    `SELECT channels FROM conversations WHERE id = $1`, [conversationId]);
  return r.rows[0]?.channels ?? [];
}
