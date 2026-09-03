/**
 * Recalling a document on a phone call, days later (plan S41).
 *
 *   "call the voice agent and ask it to explain the improvement opportunities
 *    from two days ago" — Jarvis finds that document, and **explains it
 *    conversationally rather than reading it out.**
 *
 * S38 established that a channel is an endpoint. **A phone call is three of
 * them.** The text Jarvis speaks goes to ElevenLabs to be synthesised, the audio
 * crosses Telnyx, and what he says back goes to Whisper. Explaining a
 * confidential report on a call hands its contents to a TTS vendor — which is
 * what ADR 005 forbids for models, arriving through a vendor nobody thought to
 * classify.
 *
 * Blocking it outright would be wrong: "a Jarvis that will not discuss half his
 * work on the phone is a worse assistant than one that discusses it carefully."
 * So confidential documents are explained at METADATA level.
 *
 * THE STRUCTURE THAT MAKES THIS TRUE RATHER THAN INTENDED. The plan's test is
 * emphatic about where to look — "assert on the outbound payload, not on what
 * was heard" — so the body is not withheld by a rule that remembers to withhold
 * it. `explainableFacts()` projects a document down to things that are not its
 * contents, and the confidential rendering is built from that projection alone.
 * It never holds the body, so no later edit to the phrasing can leak one. This
 * is the same shape as S40's user-facing plan, for the same reason: a prompt is
 * one edit away from saying anything it can reach.
 *
 * AND BOTH HALVES. "Ask for a normal one -> read and explained freely. **Both
 * halves, or the rule is just switched off.**" A system that explains everything
 * at metadata level passes every confidentiality assertion here and is useless,
 * so the normal path carries the body and the suite holds it to that.
 */
import { strictestOf, type Confidentiality } from "./brevity.js";

export type { Confidentiality };

/** What a recall found, before anything decides how to say it. */
export type RecalledDocument = {
  artifactId: string;
  title: string;
  /** report, analysis, findings, options… */
  kind: string;
  writtenAt: Date;
  /** Every project the document draws on. S38's rule: mixed is confidential. */
  projects: Confidentiality[];
  /** The document itself. Present here, and deliberately not everywhere. */
  body: string;
  /** The one-line conclusion, held apart from the body so it can be spoken. */
  recommendation?: string | null;
  /** How many options it weighed, how many tradeoffs it names. Shape, not content. */
  optionCount?: number | null;
  tradeoffCount?: number | null;
};

/**
 * A document reduced to things that are not its contents.
 *
 * Note what is absent and note that the absence is the mechanism: there is no
 * `body` field, so the confidential rendering cannot mention one. A version of
 * this that carried the body and promised not to use it would be one edit away
 * from using it.
 *
 * `recommendation` is here on purpose and it is the interesting judgement in the
 * file. The plan's own example speaks it — "recommends option two, mostly on
 * cost" — so a conclusion is sayable while the reasoning behind it is not. That
 * is a real line, not an obvious one, and it is the plan's line.
 */
export type ExplainableFacts = {
  title: string;
  kind: string;
  writtenAt: Date;
  recommendation: string | null;
  optionCount: number | null;
  tradeoffCount: number | null;
  classification: Confidentiality;
};

/** The projection, built field by field so a new field on the document stays put. */
export function explainableFacts(doc: RecalledDocument): ExplainableFacts {
  return {
    title: doc.title,
    kind: doc.kind,
    writtenAt: doc.writtenAt,
    recommendation: doc.recommendation ?? null,
    optionCount: doc.optionCount ?? null,
    tradeoffCount: doc.tradeoffCount ?? null,
    classification: strictestOf(doc.projects),
  };
}

export type VoiceRendering = {
  /** `read` carries the document; `explain` carries facts about it. */
  mode: "read" | "explain";
  /** Exactly what will be synthesised. Nothing else is spoken. */
  say: string;
  /** Where the detail can be had, when it cannot be had here. */
  offer: "whatsapp" | "console" | null;
  why: string;
};

/**
 * How this document is said on a call.
 *
 * The classification decides, and it is taken from the PROJECTS the document
 * draws on rather than from the document: "a document spanning both takes the
 * stricter classification present", which is S38's rule and S38's function.
 */
export function voiceRendering(doc: RecalledDocument): VoiceRendering {
  const classification = strictestOf(doc.projects);

  if (classification === "normal") {
    /*
     * The other half. A system that explains everything at metadata level
     * satisfies every confidentiality assertion in this file and is useless -
     * he asked for this feature specifically.
     */
    return {
      mode: "read",
      say: forSpeaking(doc.body),
      offer: null,
      why: "a normal project's document is read and explained freely",
    };
  }

  /*
   * From the projection alone. The body is not in scope in this branch, which is
   * what makes "the confidential body never reaches the TTS request" a fact
   * about the code rather than a thing to check for in review.
   */
  return {
    mode: "explain",
    say: explainAloud(explainableFacts(doc)),
    offer: "whatsapp",
    why: `${classification} work is described, not synthesised: the text spoken goes to a TTS vendor, `
      + "and that is a third party ADR 005 would not have allowed for a model",
  };
}

/**
 * The sentence the plan writes out, generated from facts.
 *
 *   "The Alpha migration report recommends option two, mostly on cost. There are
 *    three tradeoffs. Do you want them in the console, or shall I walk through
 *    the shape of it?"
 *
 * Every clause here is metadata. Nothing in it came from the document's text.
 */
function explainAloud(f: ExplainableFacts): string {
  const parts: string[] = [];
  parts.push(f.recommendation
    ? `The ${f.title} ${f.kind} recommends ${f.recommendation}.`
    : `The ${f.title} ${f.kind} is from ${plainDate(f.writtenAt)}.`);
  if (f.optionCount) parts.push(`It weighs ${count(f.optionCount)} option${f.optionCount === 1 ? "" : "s"}.`);
  if (f.tradeoffCount) {
    parts.push(`There ${f.tradeoffCount === 1 ? "is" : "are"} ${count(f.tradeoffCount)} tradeoff${f.tradeoffCount === 1 ? "" : "s"}.`);
  }
  parts.push("Do you want the detail on WhatsApp, or shall I walk through the shape of it?");
  return parts.join(" ");
}

/**
 * A document written to be skimmed is unbearable read aloud.
 *
 * "**Voice explanation is a different rendering, not a recitation.**" The Debug
 * note gives the test: "if the voice agent reads headings aloud, it is reciting
 * rather than explaining... whether someone driving could follow it." So the
 * furniture of a written document - headings, bullets, table pipes, link
 * brackets - comes out, because none of it survives being heard.
 */
export function forSpeaking(body: string): string {
  return body
    .split("\n")
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/^\s*\d+\.\s+/, "")
      .replace(/\|/g, " ")
      .replace(/`+/g, "")
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"))
    /*
     * Runs of whitespace collapse. A table row loses its pipes and keeps the
     * column padding otherwise, and "forty   minutes" is a written artefact that
     * a synthesiser reads as a pause in the wrong place.
     */
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && !/^[-=]{3,}$/.test(l))
    .join(" ");
}

/**
 * What actually leaves the box for the synthesiser.
 *
 * A separate function from the rendering so the plan's instruction — "assert on
 * the outbound payload, not on what was heard" — has something to be asserted
 * against. It takes the rendering and can reach nothing else; there is no
 * argument here through which a document could arrive.
 */
export function ttsPayload(rendering: VoiceRendering): { text: string } {
  return { text: rendering.say };
}

/* ------------------------------------------------------------------ *
 * The transcript is a copy, and it outlives the call.
 * ------------------------------------------------------------------ */

/**
 * What a call's transcript must be classified as.
 *
 * S38's `strictestOf`, deliberately - the plan says "as in S38, a document
 * spanning both takes the stricter treatment", so it is the same function and
 * not a second one that agrees with it today.
 *
 * An empty list gives `restricted`, which is `strictestOf`'s fail-closed answer:
 * a call whose subject nobody recorded is not a call to read back aloud on the
 * strength of that absence.
 */
export function transcriptClassification(discussed: Confidentiality[]): Confidentiality {
  return strictestOf(discussed);
}

/**
 * May this be synthesised?
 *
 * Used for documents and for transcripts alike, which is the point: "a later
 * voice recall will not read IT aloud either". A transcript of a confidential
 * discussion is confidential, and there is one rule rather than a document rule
 * and a transcript exception.
 */
export function mayReadAloud(classification: Confidentiality | null): boolean {
  return classification === "normal";
}

/* ------------------------------------------------------------------ *
 * Finding it in the first place.
 * ------------------------------------------------------------------ */

export type When = { from: Date; to: Date; phrase: string };

const DAY = 24 * 60 * 60 * 1000;

/**
 * "two days ago", "yesterday", "last week".
 *
 * Resolved to a WHOLE DAY rather than to an instant. "Two days ago" means that
 * day, not that moment forty-eight hours back, and a range anchored to the
 * current clock time silently excludes a document written in the morning when
 * he asks in the evening.
 */
export function resolveWhen(phrase: string, now: Date): When | null {
  const p = phrase.toLowerCase().trim();
  const startOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayRange = (daysAgo: number): When => {
    const from = startOf(new Date(now.getTime() - daysAgo * DAY));
    return { from, to: new Date(from.getTime() + DAY), phrase };
  };

  if (/^today$/.test(p)) return dayRange(0);
  if (/^yesterday$/.test(p)) return dayRange(1);
  const n = /^(\d+|a|two|three|four|five|six|seven)\s+days?\s+ago$/.exec(p);
  if (n) return dayRange(wordToNumber(n[1]));
  if (/^last week$/.test(p)) {
    const to = startOf(new Date(now.getTime() - 6 * DAY));
    return { from: new Date(to.getTime() - 7 * DAY), to: new Date(to.getTime() + DAY), phrase };
  }
  if (/^this week$/.test(p)) {
    return { from: startOf(new Date(now.getTime() - 6 * DAY)), to: new Date(startOf(now).getTime() + DAY), phrase };
  }
  return null;
}

function wordToNumber(w: string): number {
  const words: Record<string, number> = { a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  return Object.hasOwn(words, w) ? words[w] : Number(w);
}

function count(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return n < words.length ? words[n] : String(n);
}

function plainDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type RecallQuery = {
  /** A relative phrase, if he used one. */
  when?: string | null;
  /** "the one about scraping" — matched against content. */
  about?: string | null;
  projectId?: string | null;
  now?: Date;
};

export type RecallResult =
  | { found: true; document: RecalledDocument }
  | { found: false; say: string };

/**
 * What to say when there is nothing.
 *
 * "Ask for something that does not exist -> **says so, does not improvise a
 * plausible summary.**" This is a value rather than a prompt instruction for
 * exactly that reason: the failure mode is a model filling a silence, and the
 * way to not fill it is to have the sentence already written.
 */
export function nothingFound(q: RecallQuery): RecallResult {
  const bits = [q.about ? `about ${q.about}` : null, q.when ? `from ${q.when}` : null]
    .filter(Boolean).join(" ");
  return {
    found: false,
    say: `I don't have anything ${bits || "matching that"}. I'm not going to guess at one.`,
  };
}
