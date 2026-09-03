/**
 * Turn a written answer into something that can be read down a phone line.
 *
 * From a real call, 2026-09-02 12:24:38Z. The desk answered with its WRITTEN
 * reply — markdown bold, bullet lists, ✅ and ⚠️ emoji, model version strings,
 * prices — about a hundred and fifty words of it. ElevenLabs spent 7.4 seconds
 * rendering that, the caller heard the first seven, and the rest was cut off.
 * The transcript read beautifully. The call delivered almost none of it.
 *
 * Two separate faults, and this file is the second one: a written answer is not
 * a spoken answer, and nothing was converting between them. What goes down the
 * line is plain prose, short, with no markup a voice cannot pronounce.
 */

/** About two sentences. Past this, a phone call is the wrong medium. */
export const SPOKEN_LIMIT = 320;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

/**
 * Anything that would be read out as an address.
 *
 * Deliberately wider than "starts with http": a bare `jarvis.example.com/x` is
 * just as unspeakable, and an auth link read down a phone is a token dictated
 * aloud into whatever the room can hear. Email addresses too - "a at b dot com"
 * is not an instruction anybody can follow at walking pace.
 */
const URLISH = new RegExp(
  // Built with `new RegExp` from an explicit string rather than a literal.
  // DEBUG_NOTES records this exact trap: a backslash-b written through a
  // generator became an actual BACKSPACE character, and the resulting regex
  // "survived grep, survived tsc, compiled, and matched nothing". A character
  // class is legible where a control character is not.
  "(?:https?://[^\\s]+"
  + "|www[.][^\\s]+"
  + "|[a-z0-9-]+(?:[.][a-z0-9-]+)+/[^\\s]*"
  + "|[^\\s@]+@[^\\s@]+[.][a-z]{2,})",
  "gi",
);

export type SpokenPlan = {
  /** What the phone says. Never contains an address. */
  say: string;
  /** Every address lifted out, in the order they appeared. */
  links: string[];
  truncated: boolean;
};

/**
 * What to say, and what to send instead of saying it (plan S39).
 *
 *   "**A URL never goes down the phone.** When a voice workflow needs one - an
 *    auth link, a PR, a document - Jarvis says it is sending it to WhatsApp,
 *    and sends it. **That sentence is part of the spoken flow, not an apology
 *    afterwards.**"
 *
 * So the promise is spoken in the same breath as the answer, and the caller
 * gets the links back to deliver. A version that stripped the URL and said
 * nothing would satisfy "no URL was spoken" and leave him waiting for a link
 * that never arrives - which is worse than reading it out, because at least a
 * dictated URL tells him one exists.
 */
export function speakableWithLinks(text: string): SpokenPlan {
  const links: string[] = [];
  const stripped = (text ?? "").replace(URLISH, (m) => {
    links.push(m.replace(/[.,;:)\]]+$/, ""));
    return " ";
  });

  const base = speakable(stripped);
  if (!links.length) return { say: base.say, links, truncated: base.truncated };

  const promise = links.length === 1
    ? "I am sending you the link on WhatsApp."
    : `I am sending you the ${links.length} links on WhatsApp.`;
  /*
   * Appended AFTER the length cap, so the promise cannot be the thing that gets
   * truncated away. A cap that can eat the sentence explaining where the link
   * went is a cap that produces exactly the silence this rule exists to
   * prevent.
   */
  const say = base.say ? `${base.say} ${promise}` : promise;
  return { say, links, truncated: base.truncated };
}

/**
 * Strip everything a voice cannot say, and cap the length.
 *
 * Returns the line to speak and whether anything was left behind, so the caller
 * can be told where the rest is rather than simply losing it.
 */
export function speakable(text: string): { say: string; truncated: boolean } {
  let s = text ?? "";

  // Markdown emphasis, code fences, inline code, links.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/(\*\*|__|\*|_)/g, "");
  // Headings and blockquotes.
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  // Bullets and numbered lists become sentences, not silence.
  s = s.replace(/^\s*[-*•]\s+/gm, "");
  s = s.replace(/^\s*\d+[.)]\s+/gm, "");
  // Tables are hopeless out loud; keep the words, drop the scaffolding.
  s = s.replace(/\|/g, " ");
  s = s.replace(/^[\s:-]{4,}$/gm, " ");

  s = s.replace(EMOJI, " ");
  // Every line break becomes a sentence break, or the whole thing runs together.
  s = s.replace(/\n{2,}/g, ". ");
  s = s.replace(/\n/g, ". ");
  s = s.replace(/\.\s*\./g, ".");
  s = s.replace(/\s{2,}/g, " ").trim();

  if (s.length <= SPOKEN_LIMIT) return { say: s, truncated: false };

  // Cut at a sentence end if there is one in the last third, so the line does
  // not stop mid-clause.
  const head = s.slice(0, SPOKEN_LIMIT);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  const cut = lastStop > SPOKEN_LIMIT * 0.6 ? head.slice(0, lastStop + 1) : `${head.trim()}…`;
  return { say: `${cut} The rest is in the Control Center.`, truncated: true };
}
