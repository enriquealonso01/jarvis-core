import type pg from "pg";
import { checksum, runSupervisorTurn } from "./supervisor.js";
import { raiseIssue } from "./notify.js";
import { looksConfidential } from "./redaction.js";
import { applyRouteB, deterministicRoute } from "./routeb.js";
import { applyRoute, summariseRoute, type RouteOutcome } from "./routing.js";
import { classifyInbox } from "./routing.js";

/**
 * A readable thread name taken from the first thing said in it.
 *
 * Naming a thread before saying anything is friction with no payoff: the
 * first message describes the thread better than a label typed ahead of it.
 * This runs on the first message of any channel — web, WhatsApp, phone — so
 * no thread anywhere is left sitting as "New thread".
 */
const NL = "\n";

export function deriveThreadTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // An opener that addresses Jarvis says nothing about the thread.
  const body =
    flat.replace(/^(hey|hi|hello|ok|okay|yo)?[\s,]*jarvis[\s,:—-]*/i, "").trim() || flat;
  // Prefer the first sentence when one is short enough to stand as a title.
  const sentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
  const source = sentence.length <= 64 ? sentence : body;
  let title = source.replace(/[.,;:\s]+$/, "");
  if (title.length > 64) {
    const cut = title.slice(0, 64);
    const space = cut.lastIndexOf(" ");
    title = (space > 24 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, "") + "…";
  }
  if (!title) return "New chat";
  return title[0].toUpperCase() + title.slice(1);
}

export async function ingestUserMessage(
  pool: pg.Pool,
  args: {
    conversationId: string;
    body: string;
    inboxId?: string;
    /**
     * Called the moment ROUTING is done, before the Supervisor is asked
     * anything (S22).
     *
     * The phone runtime needs to know this and cannot wait for the whole call
     * to return. Its budget ladder hands over at 25 seconds, and on a real call
     * the desk took longer than that — so the handover created a task of its
     * own while the router was still about to create the correctly-scoped one.
     * Two tasks for one sentence, the second with no project at all.
     *
     * A callback rather than a second entry point: the plan's one-input-path
     * rule is what makes the phone and WhatsApp provably identical, and a
     * parallel copy of this function is how that stops being true.
     */
    onRouted?: (result: { tasks: string[]; passthrough: boolean }) => void;
  },
): Promise<{ inboxId: string; assistant?: string; error?: string }> {
  const conv = await pool.query<{
    id: string;
    project_id: string | null;
    confidentiality: string | null;
    project_name: string | null;
  }>(
    `SELECT c.id, c.project_id, p.confidentiality, p.name AS project_name
     FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1`,
    [args.conversationId],
  );
  if (!conv.rows[0]) {
    throw new Error("conversation not found");
  }
  const text = args.body.trim();
  if (!text) {
    throw new Error("empty message");
  }

  // Channel adapters (the OpenClaw bridge, webhooks) have already persisted the
  // event before calling in. Reuse that row instead of writing a second one,
  // otherwise every WhatsApp message shows up twice in the Inbox and the
  // adapter's row is left on 'pending' forever.
  // ADR 005: a confidential or restricted project's body never reaches the
  // Supervisor's provider account — only metadata does.
  const confidential = ["confidential", "restricted"].includes(
    conv.rows[0].confidentiality ?? "",
  );
  let payloadMode: "full" | "metadata_only" = confidential ? "metadata_only" : "full";

  let inboxId = args.inboxId ?? "";
  if (!inboxId) {
    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events (
         channel, sender, raw_text, checksum, capture_state, processing_state,
         conversation_id, project_id, supervisor_payload_mode
       ) VALUES (
         'web', 'enrique', $1, $2, 'persisted', 'pending', $3, $4, $5
       ) RETURNING id`,
      [text, checksum(text), args.conversationId, conv.rows[0].project_id, payloadMode],
    );
    inboxId = inbox.rows[0].id;
  } else {
    await pool.query(`UPDATE inbox_events SET supervisor_payload_mode = $2 WHERE id = $1`, [
      inboxId,
      payloadMode,
    ]);
  }

  await pool.query(
    `INSERT INTO messages (conversation_id, inbox_event_id, role, body)
     VALUES ($1, $2, 'user', $3)`,
    [args.conversationId, inboxId, text],
  );
  // Title the thread from its first message, and only its first: a thread
  // already named — by Enrique or by an earlier message — keeps its name.
  await pool.query(
    `UPDATE conversations
     SET last_activity_at = now(),
         title = CASE WHEN title IS NULL OR btrim(title) = '' OR title = 'New thread'
                      THEN $2 ELSE title END
     WHERE id = $1`,
    [args.conversationId, deriveThreadTitle(text)],
  );

  /*
   * Stage B, before any model (ADR 005, S12b item 1).
   *
   * This is the gap S12b lists as LIVE: `classifyInbox` was the first thing to
   * read an inbound body, and it is a model call. Now the project and the
   * conversation are decided from the message itself — a `#slug`, a reply
   * pointer, the ten-minute correlation window — and the verdict is written onto
   * the event before anything is sent anywhere.
   *
   * What it buys is not tidiness. A confidential project is known BEFORE the
   * Supervisor is asked, so its body is never what a model reads first.
   */
  const origin = await pool.query<{ channel: string; sender: string | null }>(
    "SELECT channel, sender FROM inbox_events WHERE id = $1",
    [inboxId],
  );
  const stageB = await deterministicRoute(pool, {
    inboxId,
    text,
    channel: origin.rows[0]?.channel ?? "web",
    sender: origin.rows[0]?.sender ?? null,
    conversationId: args.conversationId,
  }).catch((err) => {
    console.error("stage B failed; falling through to the classifier:", err);
    return null;
  });
  if (stageB) {
    await applyRouteB(pool, inboxId, stageB).catch(() => undefined);
    if (stageB.payloadMode === "metadata_only") payloadMode = "metadata_only";
  }

  /*
   * A confidential body with a project now assigned goes no further.
   *
   * ADR 005: "An LLM is never the first reader of a confidential body." With
   * the project known deterministically there is nothing left for a model to
   * decide about WHERE this belongs, and the ADR forbids it seeing WHAT is in
   * it. So it is filed, in that project, with zero model calls — which is the
   * plan's own test for this item.
   */
  if (stageB?.projectId && stageB.confidential) {
    await pool.query(
      `UPDATE inbox_events SET processing_state = 'processed',
         routing_note = $2
       WHERE id = $1`,
      [inboxId, `filed in ${stageB.projectSlug} by stage B; body withheld from the model (ADR 005)`],
    );
    const filed = `Filed in ${stageB.projectSlug}. It looks like code or logs, so I have not read it — open it in that project when you want it worked on.`;
    await pool.query(
      `INSERT INTO messages (conversation_id, inbox_event_id, role, body) VALUES ($1, $2, 'jarvis', $3)`,
      [args.conversationId, inboxId, filed],
    );
    return { inboxId, assistant: filed };
  }

  if (!conv.rows[0].project_id && !stageB?.projectId && looksConfidential(text)) {
    // ADR 005 Stage C: suspected confidential body with no project assigned.
    // Fail closed rather than hand source code to a free/consumer model.
    await pool.query(
      `UPDATE inbox_events SET processing_state = 'pending',
         routing_note = 'held: looks like code or logs and no project is assigned'
       WHERE id = $1`,
      [inboxId],
    );
    await raiseIssue(pool, {
      category: "security.broker_deny",
      service: "supervisor",
      owner: "user",
      status: "waiting_for_user",
      title: "[routing] Which project is this?",
      dedupeKey: `routing.unassigned.${inboxId}`,
      evidence: { inbox_id: inboxId },
      requiredAction:
        "This looks like code or logs and no project is assigned. Route it to a project on the Inbox page and Jarvis will process it there — it was not sent to the Supervisor's provider account.",
      notifyOverride: "ui_only",
    });
    const held =
      "Stored, but not sent to the Supervisor: this looks like code or logs and the thread has no project. " +
      "Assign it to a project on the Inbox page (or ask me in a project thread) and I will pick it up there. " +
      "Nothing was sent to a shared provider account.";
    await pool.query(
      `INSERT INTO messages (conversation_id, inbox_event_id, role, body) VALUES ($1, $2, 'jarvis', $3)`,
      [args.conversationId, inboxId, held],
    );
    return { inboxId, assistant: held };
  }

  // S3a: decide what he meant before anything acts on it, and write the verdict
  // down. classifyInbox never throws - the message is already durable and a
  // router that could take the turn down with it would be a new way to lose
  // input. An unusable verdict is recorded as `ambiguous`, not guessed at.
  const decision = await classifyInbox(pool, {
    inboxId,
    text,
    conversationId: args.conversationId,
  });

  // S3b: act on the decision. One message can reach several destinations, and
  // each of them points back at this inbox event.
  //
  // When the router handled it, the Supervisor is NOT also run over the same
  // segments: it has task_create too, and both acting on one sentence is how
  // you get two tasks for one request. Questions are the exception - they are
  // what the Supervisor is for - so a memo that is part work and part question
  // gets the work filed here and the question answered there.
  let outcome: RouteOutcome = { destinations: [], questions: [], passthrough: true };
  try {
    outcome = await applyRoute(pool, {
      inboxId,
      sourceConversationId: args.conversationId,
      sourceProjectId: conv.rows[0].project_id,
      decision,
    });
  } catch (err) {
    // Routing failing must not cost the message. Fall back to the pre-S3 path.
    await pool
      .query(`UPDATE inbox_events SET routing_note = $2 WHERE id = $1`, [
        inboxId,
        `route application failed: ${err instanceof Error ? err.message : String(err)}`,
      ])
      .catch(() => undefined);
    outcome = { destinations: [], questions: [], passthrough: true };
  }

  if (args.onRouted) {
    const made = await pool
      .query<{ id: string }>("SELECT id FROM tasks WHERE origin_inbox_id = $1", [inboxId])
      .catch(() => ({ rows: [] as { id: string }[] }));
    try {
      args.onRouted({ tasks: made.rows.map((r) => r.id), passthrough: outcome.passthrough });
    } catch {
      /* a listener must never take the message down */
    }
  }

  if (!outcome.passthrough) {
    let assistant = summariseRoute(outcome);
    if (outcome.questions.length) {
      const answered = await runSupervisorTurn(pool, {
        conversationId: args.conversationId,
        inboxId,
        userText: outcome.questions.join(NL),
        payloadMode,
        projectName: conv.rows[0].project_name,
        confidentiality: conv.rows[0].confidentiality,
      }).catch((err: unknown) => `I could not answer that part: ${err instanceof Error ? err.message : String(err)}`);
      assistant = assistant ? [assistant, answered].join(NL + NL) : answered;
    }
    if (!assistant) assistant = "Nothing in that needed doing.";
    await pool.query(
      `INSERT INTO messages (conversation_id, inbox_event_id, role, body)
       VALUES ($1, $2, 'jarvis', $3)`,
      [args.conversationId, inboxId, assistant],
    );
    await pool.query(`UPDATE inbox_events SET processing_state = 'processed' WHERE id = $1`, [inboxId]);
    await pool.query(`UPDATE conversations SET last_activity_at = now() WHERE id = $1`, [args.conversationId]);
    return { inboxId, assistant };
  }

  try {
    const assistant = await runSupervisorTurn(pool, {
      conversationId: args.conversationId,
      inboxId,
      userText: text,
      payloadMode,
      projectName: conv.rows[0].project_name,
      confidentiality: conv.rows[0].confidentiality,
    });
    await pool.query(
      `INSERT INTO messages (conversation_id, inbox_event_id, role, body)
       VALUES ($1, $2, 'jarvis', $3)`,
      [args.conversationId, inboxId, assistant],
    );
    await pool.query(
      `UPDATE inbox_events SET processing_state = 'processed' WHERE id = $1`,
      [inboxId],
    );
    // A working turn is the evidence that the routing failure cleared.
    await pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE dedupe_key IN ('supervisor.fail.routing', 'provider.degraded.supervisor')
         AND status NOT IN ('resolved', 'ignored')`,
    );
    await pool.query(
      `UPDATE conversations SET last_activity_at = now() WHERE id = $1`,
      [args.conversationId],
    );
    return { inboxId, assistant };
  } catch (err) {
    await pool.query(
      `UPDATE inbox_events SET processing_state = 'failed', routing_note = $2 WHERE id = $1`,
      [inboxId, err instanceof Error ? err.message : "supervisor failed"],
    );
    // Dedupe on the failure class, not the inbox id: repeated failures of one
    // broken route are one ticket with a count, not one ticket per message.
    const detail = err instanceof Error ? err.message : "supervisor failed";
    await raiseIssue(pool, {
      category: "supervisor.fail",
      service: "supervisor",
      title: "[supervisor] turn failed — message kept",
      dedupeKey: "supervisor.fail.routing",
      evidence: { last_inbox_id: inboxId, last_error: detail },
      requiredAction:
        "Check Models: every approved supervisor route is failing. The message is stored and can be retried.",
    });
    return { inboxId, error: "Supervisor failed after persist. The message is kept." };
  }
}
