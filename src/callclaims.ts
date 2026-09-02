import { claimsAnAction } from "./supervisor.js";

/**
 * Does a spoken line claim that something was done?
 *
 * Tier 1 has no tools at all, so any such claim is false by construction. The
 * Supervisor's own `claimsAnAction` is anchored at the start of the reply, which
 * is right for a written answer that begins "Stored." and wrong here: a spoken
 * line is conversational, and "Right, I've filed that for you, sir" is the same
 * lie three words later.
 *
 * Past tense only. "I'll get that done" is a promise, and tier 1 is allowed to
 * make it, because the desk is about to do exactly that.
 *
 * Built with `new RegExp` from parts rather than written as a literal: this file
 * has been rewritten by a script twice, and both times a `\b` in the literal was
 * eaten before it reached disk, leaving a regex that silently matched nothing.
 */
const VERBS = [
  "stored", "saved", "created", "opened", "filed", "added", "registered",
  "updated", "noted", "queued", "scheduled", "deleted", "removed",
].join("|");

const SPOKEN_CLAIM_RE = new RegExp(
  [
    // "I've filed", "I have saved", or the bare participle anywhere.
    "(?:i(?:'ve| have) )?(?:" + VERBS + ")\\b",
    // "that's done", "it is sorted".
    "|(?:it|that)(?:'s| is) (?:done|filed|saved|created|sorted)\\b",
    "|\\ball done\\b",
  ].join(""),
  "i",
);

export function tierOneClaims(text: string): boolean {
  return SPOKEN_CLAIM_RE.test(text) || claimsAnAction(text);
}
