/**
 * Saying what you are about to do, like a colleague (plan S40).
 *
 *   "Before substantial or multi-step work, Jarvis says what it is about to do
 *    — **in the register of a capable colleague, not a status page.** The brief
 *    covers only: what it will do, whether Enrique needs to act, on which
 *    channel it will reach him, and how it will report completion. **No
 *    implementation detail, no internal steps** unless asked."
 *
 * The worked example is the specification:
 *
 *   "I'll set up the integration, send you the auth link on WhatsApp when it's
 *    ready, carry on once you've connected it, and message you when it's done."
 *
 * THREE THINGS THIS FILE IS BUILT AROUND.
 *
 * First, the Debug note: "If briefs read like task lists, the prompt is
 * exposing the step decomposition. The brief describes the USER-FACING flow;
 * the decomposition is internal and stays that way." So `composeBrief` is handed
 * a `UserFacingPlan` and nothing else, and `userFacing()` is the one place the
 * decomposition is dropped. Leaking a step is then impossible rather than
 * discouraged: a version that took the whole task and merely promised not to
 * mention the steps would be one prompt edit away from mentioning them.
 *
 * Second, the four-line limit is real, and what gets cut when a flow is long is
 * a decision with a right answer. The lines that can go are the ones telling him
 * about something he does not have to act on; the lines that cannot go are the
 * points where the work WAITS FOR HIM. A brief that quietly drops one of those
 * to fit has produced the exact surprise it existed to prevent — he finds out he
 * was needed only once the work has already stopped. So when they will not fit
 * as sentences they are folded into a line that still names how many there are
 * and where they will arrive: every point that needs him is accounted for,
 * by name or by count.
 *
 * Third — stated twice within four sentences of the plan, because it is the
 * thing that goes wrong: **the brief is not a permission gate.** "He can approve
 * it, change it, or ignore it... the approval rules are S42's job, and this is
 * not a second one." Ignoring a brief means the work happens. A brief that waits
 * for a reply has quietly become an approval step, and then every multi-step
 * request needs an answer before anything starts.
 */
import type pg from "pg";

export type Channel = "whatsapp" | "phone" | "console";

/** A point where the flow reaches him, or needs him. */
export type Handoff = {
  /** What he will see or be asked, in his terms rather than the system's. */
  what: string;
  /** Where it reaches him. Naming this is half the point of a brief. */
  channel: Channel;
  /** Whether the work waits here. These are the lines that may never be cut. */
  needsHim: boolean;
};

/**
 * What a brief is allowed to know.
 *
 * Deliberately not the task, not its steps, not the tools it will use, not the
 * connections it will touch. If a field is not on this type, no brief can
 * mention it.
 */
export type UserFacingPlan = {
  /** One clause: what he asked for, stated as an outcome. */
  intent: string;
  handoffs: Handoff[];
  /** How completion is reported. */
  completion: { channel: Channel };
};

/** One move in the decomposition. Internal, and it stays that way. */
export type InternalStep = { description: string; tool?: string };

/** The whole plan as the executor holds it, decomposition included. */
export type InternalTask = UserFacingPlan & { steps: InternalStep[] };

/**
 * The projection, and the only door between the two.
 *
 * Built field by field rather than by spreading the task and deleting `steps`.
 * The spread form is the same shape of mistake as a deny-list: correct about the
 * fields that exist today and silently wrong about the next one added to
 * `InternalTask`, which would begin travelling into briefs without anybody
 * choosing that.
 */
export function userFacing(task: InternalTask): UserFacingPlan {
  return {
    intent: task.intent,
    handoffs: task.handoffs.map((h) => ({
      what: h.what,
      channel: h.channel,
      needsHim: h.needsHim,
    })),
    completion: { channel: task.completion.channel },
  };
}

/** Over this it stops being a brief and becomes a status page. */
export const MAX_BRIEF_LINES = 4;

/**
 * Does this deserve a brief at all?
 *
 * "A trivial request produces **no** brief. **Briefing a one-step task is the
 * failure mode here.**"
 *
 * Read off the user-facing flow, which is the whole point and also has a
 * consequence worth stating out loud: a job with a dozen internal steps, one
 * outcome and one "done" message gets NO brief, because from where he sits it
 * is one thing. Counting internal steps here would put the decomposition back in
 * charge of briefing by a side door — briefs would then multiply exactly where
 * the system is complicated rather than where he is involved.
 */
export function needsBrief(plan: UserFacingPlan): boolean {
  if (plan.handoffs.some((h) => h.needsHim)) return true;
  return plan.handoffs.length > 1;
}

export type Brief = {
  lines: string[];
  text: string;
  /** Handoffs that got a sentence of their own. */
  named: string[];
  /** Points needing him that were folded into a count instead of named. */
  foldedCount: number;
};

/**
 * Four lines at most, each naming where it reaches him.
 *
 * Returns null when no brief is warranted, so "no brief" is a value a caller has
 * to handle rather than an empty string that renders as a blank message.
 */
export function composeBrief(plan: UserFacingPlan): Brief | null {
  if (!needsBrief(plan)) return null;

  /*
   * Two lines are spoken for before any handoff gets one: the first says what he
   * is getting, the last says how he will know it finished. Neither is a
   * candidate for cutting — a brief that drops the completion line to fit has
   * stopped answering "how will I hear about this", which is one of the four
   * things the plan says a brief is for.
   */
  const room = MAX_BRIEF_LINES - 2;
  const blocking = plan.handoffs.filter((h) => h.needsHim);
  const informational = plan.handoffs.filter((h) => !h.needsHim);

  /*
   * The folded line is a line. Budgeting only for the sentences and adding the
   * fold afterwards is how a brief that carefully respects a four-line limit
   * emits five — which is what the suite caught here, and it is the sort of
   * thing that reads as correct right up until you count.
   */
  const needsFold = blocking.length > room;
  const namedRoom = Math.max(0, needsFold ? room - 1 : room);

  /*
   * Informational lines are the ones that go. He does not have to do anything
   * about them, and the completion line already promises he will hear how it
   * ended. They are only kept while every blocking handoff already fits.
   */
  const keep: Handoff[] = blocking.slice(0, namedRoom);
  if (!needsFold) {
    for (const h of informational) {
      if (keep.length >= room) break;
      keep.push(h);
    }
  }

  const folded = blocking.slice(namedRoom);
  const lines: string[] = [`I'll ${plan.intent}.`];
  for (const h of plan.handoffs) {
    if (!keep.includes(h)) continue;
    lines.push(h.needsHim
      ? `I'll send you ${h.what} on ${say(h.channel)} and carry on once you've dealt with it.`
      : `I'll ${h.what} and let you know on ${say(h.channel)}.`);
  }
  if (folded.length) {
    /*
     * Rendered FROM the folded list rather than from a number carried
     * separately, so the sentence and `foldedCount` cannot come to disagree
     * about how many times he is going to be interrupted.
     */
    const where = [...new Set(folded.map((h) => say(h.channel)))];
    lines.push(
      `I'll need you ${folded.length} more time${folded.length === 1 ? "" : "s"} after that, on ${list(where)}.`,
    );
  }
  lines.push(`I'll message you on ${say(plan.completion.channel)} when it's done.`);

  return {
    lines,
    text: lines.join("\n"),
    named: keep.map((h) => h.what),
    foldedCount: folded.length,
  };
}

function say(channel: Channel): string {
  return channel === "console" ? "the console" : channel === "phone" ? "the phone" : "WhatsApp";
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What happens once a brief has been sent.
 *
 * Always proceed. "He can approve it, change it, or **ignore it**" — and
 * ignoring it means the work happens. Written as a function returning a constant
 * rather than as a comment saying not to wait, because a future change that
 * turns briefs into a gate then has to delete something the tests hold rather
 * than merely forget to add a wait.
 */
export function afterBrief(): { proceed: true; why: string } {
  return {
    proceed: true,
    why: "a brief is a chance to redirect before the work, not a permission gate — approvals are S42's",
  };
}

/**
 * Apply a redirection he sent in reply.
 *
 * "Changing the plan in reply ('send it to the console instead') changes the
 * execution." So this returns a new PLAN rather than a note about one. A
 * redirection that only changes what the next brief says, while the thing still
 * goes where it was always going, is the failure that looks exactly like success
 * from his side — until the message arrives on the wrong surface.
 */
export function redirect(
  plan: UserFacingPlan,
  change: { channel: Channel; applyTo?: "all" | "completion" },
): UserFacingPlan {
  const scope = change.applyTo ?? "all";
  return {
    intent: plan.intent,
    handoffs: scope === "all"
      ? plan.handoffs.map((h) => ({ ...h, channel: change.channel }))
      : plan.handoffs.map((h) => ({ ...h })),
    completion: { channel: change.channel },
  };
}

/**
 * Say it, and keep the plan that was said.
 *
 * The stored row is not a log entry. It is the plan EXECUTION READS, which is
 * what makes a redirection able to change anything: if the brief were recorded
 * beside the plan rather than as it, "send it to the console instead" would
 * update a record of the conversation while the work carried on to WhatsApp.
 *
 * Returns null — and writes nothing — when the work does not warrant a brief, so
 * the trivial case leaves no trace to be reported on either.
 */
export async function recordBrief(
  pool: pg.Pool,
  args: {
    task: InternalTask;
    conversationId?: string | null;
    projectId?: string | null;
    now?: Date;
  },
): Promise<{ id: string; brief: Brief; plan: UserFacingPlan } | null> {
  const plan = userFacing(args.task);
  const brief = composeBrief(plan);
  if (!brief) return null;

  const r = await pool.query<{ id: string }>(
    `INSERT INTO briefs (conversation_id, project_id, intent, plan, brief_text, sent_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [
      args.conversationId ?? null,
      args.projectId ?? null,
      plan.intent,
      JSON.stringify(plan),
      brief.text,
      args.now ?? new Date(),
    ],
  );
  return { id: r.rows[0].id, brief, plan };
}

/** The plan the work is actually carried out against. */
export async function planForExecution(
  pool: pg.Pool,
  briefId: string,
): Promise<UserFacingPlan | null> {
  const r = await pool.query<{ plan: UserFacingPlan }>(
    `SELECT plan FROM briefs WHERE id = $1`, [briefId]);
  return r.rows[0]?.plan ?? null;
}

/**
 * He replied "send it to the console instead".
 *
 * Rewrites the stored plan in place, so the next read by the executor sees the
 * change. `redirected_at` is recorded alongside because a brief that was
 * redirected and one that was ignored produce the same plan whenever the
 * redirection happened to agree with it, and the difference matters when
 * reconstructing afterwards why something went where it went.
 */
export async function applyRedirect(
  pool: pg.Pool,
  briefId: string,
  change: { channel: Channel; applyTo?: "all" | "completion" },
  now = new Date(),
): Promise<UserFacingPlan | null> {
  const current = await planForExecution(pool, briefId);
  if (!current) return null;
  const next = redirect(current, change);
  await pool.query(
    `UPDATE briefs SET plan = $2::jsonb, redirected_at = $3 WHERE id = $1`,
    [briefId, JSON.stringify(next), now],
  );
  return next;
}
