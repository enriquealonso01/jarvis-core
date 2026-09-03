/**
 * Approval by external impact (plan S42, which revises IV.6).
 *
 * IV.6 grades authority by WHAT THE ACTION IS. S42 replaces the governing
 * question with a better one:
 *
 *   **Can anyone other than Enrique see, receive, rely on, or be affected by
 *   this?**
 *
 * If no — do it. No prompt, no grant, just the audit row. "Excessive approval
 * requests are the friction this whole system exists to remove, and a prompt for
 * a private action is pure cost." If yes — ask, unless his current instruction
 * already explicitly authorised that exact externally visible action.
 *
 * FOUR THINGS THIS FILE IS BUILT AROUND, AND THE FIRST IS THE ONE THAT GOES
 * WRONG.
 *
 * ONE: **visibility is a property of the action, not of the tool.** The Debug
 * note names the failure exactly — "the usual error is treating the tool as
 * external rather than the action" — so there is no per-tool table here and
 * there deliberately cannot be one. `impactOf` is given who can see the RESULT,
 * and the same GitHub push is private on a solo repository and external on one
 * with collaborators. "A blanket rule per tool is how you get both false prompts
 * and false confidence."
 *
 * TWO: **Jarvis does not ask twice.** If he said to do it and the external
 * consequence is an obvious part of it, that instruction IS the approval.
 * "Send that email to the client" is not followed by "are you sure?" — that is
 * "exactly the redundant friction the requirements name". So `origin` is
 * required on every decision, and an action Jarvis proposed, inferred or
 * expanded beyond the request does not inherit the authority of one he asked
 * for.
 *
 * THREE: **this widens what proceeds without asking; it does not weaken what
 * invalidates an authorisation.** The step says so itself, because it could be
 * misread the other way. Level 3 stays always-confirm as a FLOOR, the immutable
 * list is untouched, and S10's invalidation conditions are not this file's to
 * relax — `checkGrant` still runs, and this decides only whether it needs to.
 *
 * FOUR: **learning narrows prompts and may never move the boundary.** "Learning
 * may make Jarvis ask less about private actions. It may never teach itself that
 * an external action has become internal." That is enforced by type rather than
 * by care: a `LearnedPreference` has nowhere to say "external", so the sentence
 * cannot be written.
 */
import { isAlwaysConfirm } from "./policy.js";
import { levelOf } from "./grant.js";

/**
 * Who, other than Enrique, is reached by the RESULT of this action.
 *
 * Facts about the specific action, gathered by the caller. Deliberately not a
 * tool name: nothing here can be answered by knowing which product it belongs
 * to, which is the whole point.
 */
export type Reach = {
  /** People other than Enrique who can see or receive the result. */
  audience: string[];
  /**
   * Something outside the box now depends on this — a deployed service, a
   * published package, a sent message. Reversibility is not the question; being
   * relied upon is.
   */
  reliedOn?: boolean;
  /** It leaves the box at all: sent, published, deployed, transferred. */
  leavesTheBox?: boolean;
};

export type Impact = {
  external: boolean;
  /** Who, so the prompt can say it and the audit row can be read later. */
  who: string[];
  why: string;
};

/**
 * The governing question, asked of one action.
 *
 * Note there is no `tool` parameter and no table keyed by one. Adding either is
 * how "the same service holds both" — a private repository and one collaborators
 * depend on — collapses into a single wrong answer for both.
 */
export function impactOf(reach: Reach): Impact {
  const audience = reach.audience.filter((a) => a && a !== "enrique");
  if (audience.length) {
    return {
      external: true,
      who: audience,
      why: `${audience.join(", ")} can see or receive this`,
    };
  }
  if (reach.reliedOn) {
    return { external: true, who: [], why: "something outside the box relies on this" };
  }
  if (reach.leavesTheBox) {
    return { external: true, who: [], why: "this leaves the box" };
  }
  return {
    external: false,
    who: [],
    why: "nobody but Enrique will ever see or be affected by this",
  };
}

/**
 * Where the action came from, and it is required.
 *
 * `instructed` means he asked for this action, and the external consequence is
 * an obvious part of what he asked for. The other three are the ones the plan
 * gates: "the approval gate is for externally visible actions Jarvis proposes,
 * infers, expands beyond the request, or initiates on its own."
 *
 * Required rather than defaulted because the lenient value is `instructed`, and
 * a caller that forgets would get the answer that skips the prompt. S10's
 * condition 2 — a grant dies when scope materially expands — and this are one
 * rule seen from two ends.
 */
export type Origin = "instructed" | "proposed" | "inferred" | "expanded";

export type ApprovalDecision = {
  /** ask: stop and get a live approval. proceed: do it. */
  outcome: "proceed" | "ask";
  /** Does this need one of S10's grants recorded against it? */
  needsGrant: boolean;
  why: string;
  impact: Impact;
  /**
   * This prompt came from the always-confirm floor, and nothing may remove it.
   *
   * It travels ON the decision rather than being re-derived by whoever wants to
   * narrow it: an always-confirm action can perfectly well be PRIVATE - exporting
   * secrets on a solo project has no audience at all - so a guard that only
   * checked `impact.external` let learning suppress a Level 3 prompt. The suite
   * caught exactly that, which is what the assertion was written for.
   */
  floor: boolean;
};

export type ApprovalInput = {
  action: string;
  reach: Reach;
  origin: Origin;
  /**
   * Learned preferences that may suppress a prompt. See `LearnedPreference`:
   * they can only ever speak about private actions.
   */
  learned?: LearnedPreference[];
};

/**
 * Should this stop and ask?
 *
 * Order matters and it is the order the plan gives: the floors first, because
 * they are floors, and only then the visibility question that S42 adds.
 */
export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const impact = impactOf(input.reach);

  /*
   * THE FLOOR, CHECKED FIRST. "The three levels survive as a floor, not the
   * decision... Level 3 actions are externally impactful by definition and still
   * always-confirm." Checked before visibility so that no reasoning about
   * audience can ever conclude that a production deploy is private — which it
   * could, on a solo project nobody else uses.
   */
  if (levelOf(input.action) === 3 || isAlwaysConfirm(input.action)) {
    return {
      outcome: "ask",
      needsGrant: true,
      why: `${input.action} is always-confirm; S42 widens what proceeds without asking and does not touch this`,
      impact,
      floor: true,
    };
  }

  if (!impact.external) {
    /*
     * "This is where most of the friction disappears, and it disappears by doing
     * LESS, not by adding a mechanism." No grant: S10's machinery exists for
     * externally visible work, and issuing one here would be a record of an
     * authorisation nobody needed.
     */
    return { outcome: "proceed", needsGrant: false, why: impact.why, impact, floor: false };
  }

  if (input.origin === "instructed") {
    /*
     * "Jarvis does not ask twice." The instruction authorises; the grant records
     * WHAT it authorised, for which task, against which commit, until when - so
     * this proceeds and still needs a grant, which is the plan's own
     * distinction and not a hedge.
     */
    return {
      outcome: "proceed",
      needsGrant: true,
      why: "he asked for this, and the external consequence is an obvious part of it",
      impact,
      floor: false,
    };
  }

  return {
    outcome: "ask",
    needsGrant: true,
    why: `${impact.why}, and this is something Jarvis ${input.origin} rather than something he asked for`,
    impact,
    floor: false,
  };
}

/* ------------------------------------------------------------------ *
 * Learning: narrowing the prompts, never widening the boundary.
 * ------------------------------------------------------------------ */

/**
 * Something learned from his approvals, corrections and overrides.
 *
 * `scope` has ONE value and that is the enforcement. "Learning may make Jarvis
 * ask less about private actions. It may never teach itself that an external
 * action has become internal" — so there is no way to write down a preference
 * about an external action. A boolean flag with a comment saying not to set it
 * for external actions is a comment; this is a type error.
 */
export type LearnedPreference = {
  scope: "private";
  action: string;
  /** He approved this kind of private action this many times without changing it. */
  approvals: number;
};

/** Enough of a pattern to stop asking. Below it, the prompt stays. */
export const LEARNING_THRESHOLD = 3;

/**
 * Apply what has been learned.
 *
 * Takes the decision that was already made and can only ever move it in one
 * direction, for one kind of action. An external `ask` is returned untouched —
 * and the suite asserts that with a preference that names an external action,
 * because "assert that second half, it is the one that can go wrong quietly".
 */
export function applyLearning(
  decision: ApprovalDecision,
  action: string,
  learned: LearnedPreference[] = [],
): ApprovalDecision {
  if (decision.outcome === "proceed") return decision;

  /*
   * The floor first, and it is NOT implied by the boundary below. An
   * always-confirm action can be entirely private - exporting secrets on a solo
   * project has no audience - so checking only `external` let a learned
   * preference suppress a Level 3 prompt. That is not a subtle failure; it is
   * the immutable list being negotiated with, and the suite found it.
   */
  if (decision.floor) return decision;

  /*
   * The boundary. Learning never reaches an externally visible action, whatever
   * the preferences say about it - and they cannot say anything about one, but
   * the check is here as well because the type is a compile-time argument and
   * this is a runtime one.
   */
  if (decision.impact.external) return decision;

  const match = learned.find((p) => p.scope === "private" && p.action === action);
  if (!match || match.approvals < LEARNING_THRESHOLD) return decision;

  return {
    ...decision,
    outcome: "proceed",
    why: `${decision.why} — and he has approved this private action ${match.approvals} times without changing it`,
  };
}

/**
 * The whole decision, floors and learning together.
 *
 * One entry point so a caller cannot get the pieces in the wrong order: applying
 * learning before the floors would let a preference suppress a Level 3 prompt.
 */
export function approvalFor(input: ApprovalInput): ApprovalDecision {
  return applyLearning(decideApproval(input), input.action, input.learned ?? []);
}
