/**
 * Changing the console by asking, and the one kind that stops first (plan S43).
 *
 *   "**He should never have to know which subsystem owns a change.** He describes
 *    the outcome; Jarvis routes it."
 *
 * Most of that is ordinary engineering: "*Move the queue above the health strip*"
 * becomes a task in the Control Center project, running the S6 workflow, ending
 * in a PR. The console is a static site that displays the system rather than the
 * control plane that runs it, so a bad console deploy makes the interface wrong
 * where a bad core deploy "takes down the thing that would have told you the
 * interface was wrong". Different blast radii, different rules.
 *
 * THEN THERE IS THE SHARP ONE, and the plan flags it as such:
 *
 *   "**Not every console change is cosmetic.** The console holds the session,
 *    renders approvals, and is where every gate in this plan resolves to a human
 *    decision. A change to **how an approval is presented** — what it says, what
 *    the buttons do, which detail is shown before the click — is a
 *    security-relevant change wearing a cosmetic hat. Changes touching the
 *    approval flow, the session, or anything under IV.6 are **always-confirm
 *    regardless of how they were asked for.**"
 *
 * SO THIS IS AN ALLOW-LIST OF WHAT IS COSMETIC, not a deny-list of what is
 * sensitive. The difference is the entire safety property. A deny-list is a
 * list of the security-relevant areas somebody has thought of so far, and the
 * console will grow areas — an unknown one under a deny-list is treated as
 * cosmetic, which is the wrong way for that error to go. Here an area nobody has
 * classified stops for confirmation, and the cost of that mistake is one question.
 *
 * "*Tidy up the approvals page*" is a reasonable sentence and a change that needs
 * looking at. The plan is explicit that the pair is the test: the approval change
 * stopping proves nothing on its own if a queue-ordering change stops too, since
 * "one without the other proves only that the gate is stuck in one position".
 */

/**
 * Parts of the console where a change is ordinary work.
 *
 * Layout, ordering, what a card shows, colours within the visual direction —
 * the plan's own list. Everything here is a thing whose worst failure is that
 * the interface looks wrong, which he can see and say so about.
 */
export const COSMETIC_AREAS = [
  "layout",
  "ordering",
  "card_contents",
  "colours",
  "typography",
  "spacing",
  "labels",
  "charts",
  "empty_states",
] as const;
export type CosmeticArea = (typeof COSMETIC_AREAS)[number];

/**
 * Named for legibility in the decision, not used to decide.
 *
 * The decision is "is this on the cosmetic list", so this list can be
 * incomplete without being unsafe — it only makes the reason sentence say
 * something more useful than "not recognised".
 */
export const KNOWN_SENSITIVE_AREAS = [
  "approval_flow",
  "session",
  "auth",
  "grants",
  "secrets",
  "audit",
] as const;

export type ConsoleChange = {
  /** Which part of the console this touches. */
  area: string;
  /** What he asked for, in his words, for the task and the confirmation. */
  request: string;
};

export type ConsoleDecision = {
  /** Stop and confirm before this becomes work. */
  confirm: boolean;
  /** The project this becomes a task in, either way. */
  project: "control-center";
  why: string;
};

/**
 * Does this console change need looking at first?
 *
 * Note the shape: `confirm` is decided by ABSENCE from the cosmetic list, so
 * adding a new console area is safe by default and becomes cheap only once
 * somebody has looked at it and said it is cosmetic.
 */
export function consoleChangeGate(change: ConsoleChange): ConsoleDecision {
  if ((COSMETIC_AREAS as readonly string[]).includes(change.area)) {
    return {
      confirm: false,
      project: "control-center",
      why: `${change.area} is presentation: the worst it can do is look wrong, which he can see`,
    };
  }

  const named = (KNOWN_SENSITIVE_AREAS as readonly string[]).includes(change.area);
  return {
    confirm: true,
    project: "control-center",
    why: named
      ? `${change.area} is where a gate resolves to a human decision — always-confirm however it was asked for`
      : `${change.area} is not on the cosmetic list, and an unclassified part of the console `
        + "is treated as one that matters",
  };
}

/**
 * Which surface owns a change he described.
 *
 * "Route configuration requests to the owning surface: console repo, config
 * version, connection, schedule, prompt." He describes an outcome; this says who
 * does it, so that he never has to know.
 *
 * Deliberately returns `unknown` rather than guessing. S43's sibling steps are
 * emphatic that ambiguity produces a question rather than a guess, and a router
 * that always picks something will confidently file a connection change as a UI
 * task.
 */
export type Surface =
  | "console_repo"
  | "preference"
  | "connection"
  | "schedule"
  | "project_instructions"
  | "unknown";

export function owningSurface(request: string): Surface {
  const r = request.toLowerCase();
  if (/\b(call me|calling me|tone|detail|how much detail|which channel|quiet hours|voice)\b/.test(r)) {
    return "preference";
  }
  if (/\b(queue|health strip|page|layout|dashboard|console|screen|card|column|above|below)\b/.test(r)) {
    return "console_repo";
  }
  if (/\b(connect|connection|integration|api key|oauth|token)\b/.test(r)) return "connection";
  if (/\b(every day|weekly|schedule|at \d|cron|each morning)\b/.test(r)) return "schedule";
  if (/\b(instructions?|always|never|on this project)\b/.test(r)) return "project_instructions";
  return "unknown";
}
