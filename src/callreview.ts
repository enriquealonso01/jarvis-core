import type pg from "pg";

/**
 * A call, afterwards (plan S24).
 *
 * "Done when: a call is as reviewable as a chat thread, and audio retention
 * holds." Three of the four parts already existed — the recording with its
 * seven-day clock, the transcript artifact, and the tasks the call produced.
 * What was missing is the part a person reads first: what the call was ABOUT,
 * and any way to find it again from a later call.
 *
 * The summary is built from what was actually said and what actually happened,
 * not asked of a model. A model summary of a two-turn call is a paraphrase with
 * a chance of being wrong; the turns and the tasks are already written down.
 */

export type CallReview = {
  callControlId: string;
  from: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  turns: number;
  bargeIns: number;
  summary: string | null;
  conversationId: string | null;
  transcriptArtifactId: string | null;
  recordingArtifactId: string | null;
  /** Null once the seven days are up; the transcript outlives it. */
  recordingAvailable: boolean;
  said: { n: number; heard: string; answer: string | null; outcome: string; totalMs: number | null }[];
  tasks: { id: string; title: string; state: string; slug: string | null }[];
};

/**
 * One or two sentences, from the turns and their effects.
 *
 * Deliberately mechanical: it names what was asked and what came of it. A call
 * that produced nothing says so, which is more useful than a summary that
 * paraphrases the pleasantries.
 */
export async function buildSummary(pool: pg.Pool, ccid: string): Promise<string> {
  const turns = await pool.query<{ heard: string; outcome: string }>(
    "SELECT heard, outcome FROM call_turns WHERE call_control_id = $1 ORDER BY n",
    [ccid],
  );
  const tasks = await pool.query<{ title: string }>(
    `SELECT t.title FROM tasks t
     JOIN inbox_events i ON i.id = t.origin_inbox_id
     JOIN calls c ON c.conversation_id = i.conversation_id
     WHERE c.call_control_id = $1
     ORDER BY t.created_at`,
    [ccid],
  );

  if (!turns.rowCount) return "Nothing was said on this call.";

  const asked = turns.rows.map((t) => t.heard.trim()).filter(Boolean);
  const first = asked[0] ?? "";
  const opening =
    asked.length === 1
      ? `Asked about: ${first}`
      : `Asked about ${asked.length} things, starting with: ${first}`;

  const handed = turns.rows.filter((t) => t.outcome === "handed_over").length;
  const failed = turns.rows.filter((t) => t.outcome === "failed").length;

  const effects: string[] = [];
  if (tasks.rowCount) {
    effects.push(
      tasks.rowCount === 1
        ? `It produced one task: ${tasks.rows[0].title}.`
        : `It produced ${tasks.rowCount} tasks, including ${tasks.rows[0].title}.`,
    );
  }
  if (handed) effects.push(`${handed} turn${handed === 1 ? "" : "s"} went to the desk.`);
  if (failed) effects.push(`${failed} turn${failed === 1 ? "" : "s"} could not be answered.`);
  if (!effects.length) effects.push("Nothing came of it.");

  return `${opening.replace(/[.\s]*$/, "")}. ${effects.join(" ")}`;
}

/**
 * Write the summary down, and make it findable from a later call.
 *
 * The recall the plan asks for — "what did I ask you about Alpha yesterday?" —
 * needs the call to be reachable from a DIFFERENT conversation, which the
 * per-call thread is not. So the summary is also filed as a memory item, which
 * is what `memory_search` already reads. Using the machinery that exists beats
 * inventing a second one that only calls know about.
 */
export async function finishReview(pool: pg.Pool, ccid: string): Promise<string> {
  const summary = await buildSummary(pool, ccid);
  const call = await pool.query<{ conversation_id: string | null; from_e164: string | null; started_at: string }>(
    "SELECT conversation_id, from_e164, started_at::text AS started_at FROM calls WHERE call_control_id = $1",
    [ccid],
  );
  await pool.query("UPDATE calls SET summary = $2 WHERE call_control_id = $1", [ccid, summary]);

  const row = call.rows[0];
  if (!row) return summary;

  const heard = await pool.query<{ heard: string }>(
    "SELECT heard FROM call_turns WHERE call_control_id = $1 ORDER BY n",
    [ccid],
  );
  if (!heard.rowCount) return summary;

  /*
   * The memory carries WHAT WAS SAID as well as the summary. "What did I ask
   * you about Alpha yesterday" is answered by matching the words he used, and a
   * summary that mentions Alpha only if the summariser chose to would answer it
   * by luck.
   */
  const body =
    `On the phone (${row.started_at.slice(0, 16)}): ${summary} `
    + `He said: ${heard.rows.map((h) => h.heard).join(" / ")}`;

  await pool
    .query(
      `INSERT INTO memory_items (project_id, kind, body, source_inbox_id)
       SELECT NULL, 'call', $1,
              (SELECT id FROM inbox_events WHERE conversation_id = $2 ORDER BY received_at LIMIT 1)`,
      [body.slice(0, 4000), row.conversation_id],
    )
    .catch((err) => console.error("could not file the call in memory:", err));

  return summary;
}

/** Everything about one call, for the console. */
export async function callReview(pool: pg.Pool, ccid: string): Promise<CallReview | null> {
  const c = await pool.query<{
    call_control_id: string; from_e164: string | null; started_at: string; ended_at: string | null;
    end_reason: string | null; turns: number; barge_ins: number; summary: string | null;
    conversation_id: string | null; transcript_artifact_id: string | null;
    recording_artifact_id: string | null;
  }>(
    `SELECT call_control_id, from_e164, started_at::text AS started_at, ended_at::text AS ended_at,
            end_reason, turns, barge_ins, summary, conversation_id,
            transcript_artifact_id, recording_artifact_id
     FROM calls WHERE call_control_id = $1`,
    [ccid],
  );
  const call = c.rows[0];
  if (!call) return null;

  const said = await pool.query<{ n: number; heard: string; answer_text: string | null; outcome: string; total_ms: number | null }>(
    `SELECT n, heard, answer_text, outcome, total_ms FROM call_turns
     WHERE call_control_id = $1 ORDER BY n`,
    [ccid],
  );
  const tasks = await pool.query<{ id: string; title: string; state: string; slug: string | null }>(
    `SELECT t.id, t.title, t.state, p.slug
     FROM tasks t
     JOIN inbox_events i ON i.id = t.origin_inbox_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE i.conversation_id = $1 ORDER BY t.created_at`,
    [call.conversation_id],
  );

  /*
   * The recording is checked for EXISTENCE, not assumed from the id. Retention
   * deletes the artifact row at day seven and the transcript stays; a console
   * that offered a download for a file that had been correctly deleted would
   * make the retention rule look like a bug.
   */
  const recording = call.recording_artifact_id
    ? await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM artifacts WHERE id = $1", [call.recording_artifact_id])
    : { rows: [{ n: "0" }] };

  return {
    callControlId: call.call_control_id,
    from: call.from_e164,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    endReason: call.end_reason,
    turns: call.turns,
    bargeIns: call.barge_ins,
    summary: call.summary,
    conversationId: call.conversation_id,
    transcriptArtifactId: call.transcript_artifact_id,
    recordingArtifactId: call.recording_artifact_id,
    recordingAvailable: Number(recording.rows[0].n) > 0,
    said: said.rows.map((s) => ({
      n: s.n, heard: s.heard, answer: s.answer_text, outcome: s.outcome, totalMs: s.total_ms,
    })),
    tasks: tasks.rows,
  };
}

/** The list, newest first, for the console's calls page. */
export async function recentCalls(pool: pg.Pool, limit = 50): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `SELECT c.call_control_id, c.from_e164, c.started_at, c.ended_at, c.end_reason,
            c.turns, c.barge_ins, c.summary, c.conversation_id,
            (c.transcript_artifact_id IS NOT NULL) AS has_transcript,
            EXISTS (SELECT 1 FROM artifacts a WHERE a.id = c.recording_artifact_id) AS has_recording,
            (SELECT count(*) FROM tasks t
              JOIN inbox_events i ON i.id = t.origin_inbox_id
              WHERE i.conversation_id = c.conversation_id)::int AS task_count
     FROM calls c
     ORDER BY c.started_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}
