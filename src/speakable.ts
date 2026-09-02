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
