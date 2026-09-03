/**
 * Long answers become documents, and how they travel is a security decision
 * (plan S38).
 *
 * Two rules, and the plan is emphatic that neither is a matter of judgement.
 *
 * FIRST: "over a threshold, or whenever the content is a decision packet, the
 * message becomes covering-note-plus-attachment automatically. **The model does
 * not decide this by taste.**" So the decision is made here, from the content's
 * shape and size, before any prose exists. The Debug note says why it cannot be
 * done afterwards: "If messages are still long, the length check is probably
 * running after the model rather than shaping it... **Truncating a long answer
 * produces a bad short answer, which is worse than either.**"
 *
 * SECOND, and this is the one that is easy to read as a convenience setting:
 * "**Attachment or link is a confidentiality decision, not a convenience one.**
 * An attachment sent over WhatsApp has left the isolation boundary permanently.
 * It is on Meta's infrastructure, on his phone, and in whatever backs his phone
 * up. Jarvis cannot un-send it, retention policy does not reach it, and deleting
 * the artifact afterwards deletes only the copy Jarvis still holds."
 *
 * So the rule follows the PROJECT, not the message - and anything spanning
 * several projects takes the strictest classification present, because "a mixed
 * document is a confidential document". This is ADR 005's reasoning about
 * models applied one surface along: a confidential body does not go to a
 * consumer endpoint, and **a channel is an endpoint too**.
 */

/** As `projects.confidentiality` classifies them. */
export type Confidentiality = "normal" | "confidential" | "restricted";

/** Strictest last. The order IS the policy for a mixed document. */
const STRICTNESS: Confidentiality[] = ["normal", "confidential", "restricted"];

/**
 * The classification a document covering several projects carries.
 *
 * "Anything spanning both — a weekly report covering several projects, a
 * cross-project analysis — takes the strictest classification present. A mixed
 * document is a confidential document."
 *
 * An empty list is `restricted` rather than `normal`: a document whose projects
 * nobody could determine is not a document to attach on that basis.
 */
export function strictestOf(classes: Confidentiality[]): Confidentiality {
  if (!classes.length) return "restricted";
  return classes.reduce((worst, c) =>
    STRICTNESS.indexOf(c) > STRICTNESS.indexOf(worst) ? c : worst, "normal" as Confidentiality);
}

/**
 * Over this many characters, a message is a document.
 *
 * A number rather than a judgement, so the same content produces the same
 * decision on every surface and on every run.
 */
export const LONG_MESSAGE_CHARS = 700;

export type Delivery = "inline" | "attach" | "link";

export type ContentShape = {
  /** The rendered length, if this were sent as a message. */
  chars: number;
  /**
   * Analysis, comparison, option set, report, approval packet, weekly
   * findings. The plan lists these as documents regardless of length, because
   * what makes them documents is that a decision is taken FROM them.
   */
  decisionPacket: boolean;
  /** Every project the content draws on. */
  projects: Confidentiality[];
};

export type DeliveryDecision = {
  delivery: Delivery;
  classification: Confidentiality;
  why: string;
};

/**
 * How this goes out.
 *
 * Note the order: whether it is a DOCUMENT is decided first, from length and
 * shape; how a document TRAVELS is decided second, from confidentiality. They
 * are independent questions and answering them together is how "it is short, so
 * it can go inline" ends up applying to a confidential body.
 */
export function decideDelivery(content: ContentShape): DeliveryDecision {
  const classification = strictestOf(content.projects);
  const isDocument = content.decisionPacket || content.chars > LONG_MESSAGE_CHARS;

  if (!isDocument) {
    /*
     * "A short answer stays a short answer — the rule must not turn 'yes' into
     * a PDF." A short answer from a confidential project is still short: the
     * content is already in the message, and rendering it as a document would
     * put the same words on Meta's infrastructure with extra steps.
     */
    return {
      delivery: "inline",
      classification,
      why: content.chars <= LONG_MESSAGE_CHARS
        ? `${content.chars} characters is a message, not a document`
        : "short enough to say",
    };
  }

  if (classification === "normal") {
    return {
      delivery: "attach",
      classification,
      why: "a normal project's document is attached — that is the point, he reads it on his phone",
    };
  }
  return {
    delivery: "link",
    classification,
    why: `${classification} work is linked, never attached: an attachment has left the isolation `
      + "boundary permanently and cannot be un-sent",
  };
}

/**
 * The covering message: two lines, and the second one is the decision.
 *
 * "The covering message is two lines: what it is, and what Enrique needs to
 * decide." A covering note that summarises the document has reproduced the
 * document in the message, which is the thing being avoided.
 */
export function coveringNote(args: {
  what: string;
  decision: string;
  delivery: Delivery;
  url?: string | null;
}): string {
  const second = args.delivery === "link"
    ? `${args.decision} — ${args.url ?? "in the console"}`
    : args.decision;
  return `${args.what}\n${second}`;
}

/**
 * What a link must satisfy to be worth sending.
 *
 * "The link resolves to the artifact behind the session. **No token in the URL
 * that works without one.**" The distinction matters because the obvious
 * convenience - a one-time token so it opens without signing in - is exactly
 * what makes the link as sensitive as the attachment it was meant to replace.
 * A URL travels the same way an attachment does; only the session keeps the
 * content on the box.
 */
export function linkIsSafe(url: string): { safe: boolean; why: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, why: "not a URL" };
  }
  if (parsed.protocol !== "https:") {
    return { safe: false, why: "a link to a confidential document must be https" };
  }
  /*
   * Credentials in the URL itself.
   *
   * `https://user:pw@host/doc` is the same failure the query-parameter check
   * below is written for - it opens without a session - but it carries the
   * secret in the userinfo rather than the query, so the loop never sees it.
   * Observed passing as safe on the box before this.
   */
  if (parsed.username || parsed.password) {
    return {
      safe: false,
      why: "the URL carries credentials in it, so it opens without a session — that is the attachment it was meant to replace",
    };
  }
  for (const key of ["t", "token", "key", "access_token", "sig", "signature"]) {
    if (parsed.searchParams.has(key)) {
      return {
        safe: false,
        why: `the URL carries ${key}, so it opens without a session — that is the attachment it was meant to replace`,
      };
    }
  }
  return { safe: true, why: "resolves behind the session" };
}
