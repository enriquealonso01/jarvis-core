/**
 * Asking before the wall, not after it (plan S52).
 *
 * The steps around this one are reactive: S44 builds a capability when a request
 * needs it, S16 asks for a key when a task is already blocked, S46 hands off an
 * auth URL when an integration demands one now. This is the other half — Jarvis
 * sees the need coming "so the work is not sitting blocked when a message a few
 * minutes sooner would have cleared it".
 *
 * AND THE DISCIPLINE IS THE WHOLE STEP, because the failure mode is the opposite
 * of the feature:
 *
 *   "The failure mode is the one Enrique names the opposite of: **something that
 *    reaches out constantly is something he mutes.**"
 *
 * FOUR RULES HOLD IT.
 *
 * ONE: **every request is tied to a real task.** The Debug note is unusually
 * direct — "if it asks for things speculatively, the trigger is reading 'might be
 * useful' instead of 'a real task needs this'; **bind every request to a task id
 * or it drifts into nagging**". So `taskId` is required on `Need`. A speculative
 * need is not discouraged here, it is unconstructible.
 *
 * TWO: **it batches.** "Two things needed for one piece of work arrive as one
 * message, not two pings a minute apart."
 *
 * THREE: **it asks once.** A capability acquired once is registered and "there
 * next time without asking again" — and the Debug note says where that breaks:
 * "if it asks twice for the same capability, the registration from the first
 * acquisition did not happen; **the fix is in the register step, not the ask**".
 *
 * FOUR: **it never self-authorises from the ask.** "Approval to connect X is not
 * approval to spend on X, nor to use X in another project." So the scope of an
 * approval is returned as literals rather than as a set somebody widens.
 */

/** What a task is going to need, and cannot get for itself. */
export type Need = {
  /**
   * Required. There is no speculative need: this field is what the Debug note
   * means by "bind every request to a task id or it drifts into nagging".
   */
  taskId: string;
  kind: "credential" | "sign_in" | "connection" | "capability";
  /** The thing, in his terms. */
  what: string;
  /** Where it goes, so the message is actionable rather than a reminder. */
  where?: string | null;
  /** A provider that would have to be signed up for and paid. */
  newProvider?: string | null;
};

/**
 * When the ask happens, relative to the work.
 *
 * The plan's test is an ORDERING one — "assert on the ordering: the ask precedes
 * the block" — so this is a position rather than a timestamp: a timestamp
 * comparison passes on a system that asked and blocked in the same millisecond,
 * which is exactly the reactive behaviour this step exists to replace.
 */
export type Timing = "before_start" | "on_block";

export const ASK_AT: Timing = "before_start";

/**
 * Needs that have already been met, so they are not asked for again.
 *
 * "A capability acquired once is there next time without asking again." Held as a
 * set of capability keys rather than of task ids, because the point is that the
 * SECOND task does not ask — a per-task record would ask once per task forever.
 */
export type Register = Set<string>;

export function capabilityKey(need: Need): string {
  return `${need.kind}:${need.what.trim().toLowerCase()}`;
}

export function alreadyHave(register: Register, need: Need): boolean {
  return register.has(capabilityKey(need));
}

/**
 * Record an acquisition.
 *
 * The Debug note points here rather than at the ask: "if it asks twice for the
 * same capability, the registration from the first acquisition did not happen;
 * the fix is in the register step, not the ask."
 */
export function register(register_: Register, need: Need): Register {
  register_.add(capabilityKey(need));
  return register_;
}

export type Ask = {
  /** One message per task, however many needs it carries. */
  taskId: string;
  needs: Need[];
  message: string;
  /** A provider requires a recommendation rather than a request. */
  kind: "request" | "recommendation";
};

/**
 * Turn what is coming into what to say.
 *
 * Needs already met are dropped before anything is composed, so a task whose
 * every need is already satisfied produces NOTHING rather than an empty message —
 * "a day with no real gap produces no capability requests" is the test that keeps
 * this from becoming noise.
 */
export function asksFor(needs: Need[], have: Register = new Set()): Ask[] {
  const outstanding = needs.filter((n) => !alreadyHave(have, n));
  if (!outstanding.length) return [];

  /*
   * Grouped by task. "Two things needed for one piece of work arrive as one
   * message, not two pings a minute apart" - and the grouping key is the task
   * because that is the unit of work he would act on, not the kind of need.
   */
  const byTask = new Map<string, Need[]>();
  for (const n of outstanding) {
    byTask.set(n.taskId, [...(byTask.get(n.taskId) ?? []), n]);
  }

  return [...byTask.entries()].map(([taskId, group]) => {
    /*
     * "A gap needing a new paid provider -> a recommendation with a one-tap
     * approve, NOT a signup." One provider anywhere in the group makes the whole
     * message a recommendation, because he is being asked to open an account
     * either way and burying that under "request" is the misleading half.
     */
    const provider = group.find((n) => n.newProvider)?.newProvider ?? null;
    return {
      taskId,
      needs: group,
      kind: provider ? "recommendation" : "request",
      message: compose(group, provider),
    };
  });
}

function compose(needs: Need[], provider: string | null): string {
  const listed = needs
    .map((n) => (n.where ? `${n.what} (${n.where})` : n.what))
    .join(", and ");
  if (provider) {
    return `To get on with this I'd need ${listed}. That means an account with ${provider}, `
      + "which is yours to open — approve and I'll set it up.";
  }
  return `To get on with this I need ${listed}. Tap to hand it over and I'll carry on.`;
}

/* ------------------------------------------------------------------ *
 * What an approval to connect actually covers.
 * ------------------------------------------------------------------ */

/**
 * "It never self-authorises from the ask."
 *
 * Returned as literals rather than as a set of granted scopes, so widening this
 * means changing the type. "Approval to connect X is not approval to spend on X,
 * nor to use X in another project" — three different decisions, and the ask
 * settles exactly one of them.
 */
export function scopeOfConnectApproval(projectId: string | null): {
  connect: true;
  spend: false;
  otherProjects: false;
  boundTo: string | null;
} {
  return { connect: true, spend: false, otherProjects: false, boundTo: projectId };
}

/* ------------------------------------------------------------------ *
 * Content is not a need.
 * ------------------------------------------------------------------ */

export type NeedOrigin = "task_requirement" | "message_content" | "speculation";

/**
 * Is this a need, or something that merely mentioned one?
 *
 * "An inbound message that merely *mentions* needing an integration -> **no
 * handoff, no request** — content is not a need, and not authority." The same
 * rule S46 applies to auth links, arriving through a different door: a message
 * saying "you'll want a Maps key for this" is a fact about the message.
 */
export function isRealNeed(origin: NeedOrigin): { real: boolean; why: string } {
  if (origin === "task_requirement") {
    return { real: true, why: "a queued or running task cannot proceed without it" };
  }
  return {
    real: false,
    why: origin === "message_content"
      ? "a message mentioning a need is a fact about the message, not a need"
      : "nothing is waiting on this, so asking would be a reminder rather than a request",
  };
}

/* ------------------------------------------------------------------ *
 * A scheduled call opens with its purpose.
 * ------------------------------------------------------------------ */

/**
 * The opening line of a scheduled call.
 *
 * "It leads with the prepared subject and drives, rather than *'good morning,
 * sir'* and a silence he has to fill."
 *
 * The forward question is part of the same return value rather than left to the
 * model, because the failure is a blank greeting — and a greeting with no question
 * after it is a silence whatever it was preceded by.
 */
export function scheduledCallOpening(args: {
  greeting: string;
  /** What S23 prepared in advance. Absent means there was no subject. */
  subject: string | null;
}): { say: string; leadsWithSubject: boolean } {
  if (!args.subject) {
    /*
     * No prepared subject is not a licence to open blank: it is a call that
     * should say why it is happening at all, and "you asked me to call at this
     * time" is at least true.
     */
    return {
      say: `${args.greeting} — you asked me to call at this time. What would you like to go over?`,
      leadsWithSubject: false,
    };
  }
  return {
    say: `${args.greeting} — you asked me to call to go over ${args.subject}. `
      + "Where do you want to start?",
    leadsWithSubject: true,
  };
}
