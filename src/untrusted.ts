/**
 * S37 — content Enrique did not author.
 *
 * "A forwarded message or a pasted thread is evidence: quotable, searchable,
 * storable. An instruction found inside it becomes a proposal he confirms, never
 * an action."
 *
 * The whole rule reduces to one question asked at one place: **whose words
 * authorise this?** Only his. So the router is given his words and nothing else,
 * and the forward travels alongside as evidence — stored, quotable, searchable,
 * and structurally incapable of becoming a task.
 *
 * That is deliberately not a filter. A filter looks for dangerous phrases and
 * loses to the first paraphrase; "please delete the old records" and "the old
 * records should be cleared out" are the same request and no word list catches
 * both. Instead the untrusted text never reaches the decision at all, so what it
 * says does not matter.
 *
 * What it must NOT do is discard the forward. Enrique forwards things because he
 * wants something done about them, and a system that silently drops the content
 * is useless in a different way. It is stored in full, quoted back, and he is
 * asked — one question, and his answer is the authority the forward never had.
 */

/** What arrived: his words, somebody else's, or both. */
export type Authored = {
  /** His own words. Empty when he forwarded something and said nothing. */
  owner: string;
  /** Content he did not author. Empty when he wrote the whole message. */
  forwarded: string;
};

export function splitAuthorship(args: {
  text?: string | null;
  forwardedText?: string | null;
  isForward?: boolean;
}): Authored {
  const text = (args.text ?? "").trim();
  const forwarded = (args.forwardedText ?? "").trim();

  /*
   * `is_forward` with no separate forwarded field means the WHOLE message is
   * somebody else's — which is what WhatsApp's own forward flag means when the
   * adapter has nothing else to give. Treating the text as his in that case
   * would be the injection, so the flag wins.
   */
  if (args.isForward && !forwarded) return { owner: "", forwarded: text };
  return { owner: text, forwarded };
}

/**
 * Is there anything here that HE said?
 *
 * A forward with a covering sentence is an instruction from him about a piece of
 * evidence, and proceeds normally. A forward on its own authorises nothing, no
 * matter how imperative it reads.
 */
export function hasOwnerInstruction(a: Authored): boolean {
  return a.owner.length > 0;
}

/** How long a quoted forward may run before it stops being a quote. */
const QUOTE_LIMIT = 400;

/**
 * What to say when he forwarded something and said nothing.
 *
 * It quotes rather than summarises. A summary of an untrusted message is an
 * LLM's reading of text written to manipulate the reader, presented in Jarvis's
 * own voice — the quote marks are doing real work.
 */
export function askAboutForward(forwarded: string): string {
  const clean = forwarded.replace(/\s+/g, " ").trim();
  const quoted = clean.length > QUOTE_LIMIT ? `${clean.slice(0, QUOTE_LIMIT)}…` : clean;
  return [
    "You forwarded this and did not say what you wanted done with it:",
    "",
    `> ${quoted}`,
    "",
    "I have filed it. Tell me what you would like done and I will do that —",
    "anything it asks for itself, I have not acted on.",
  ].join("\n");
}
