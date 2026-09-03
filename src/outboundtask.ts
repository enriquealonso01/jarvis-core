/**
 * Calling a business to get something done (plan S50).
 *
 * S23 dials Enrique on a hard six-reason allow-list. This is the other
 * direction: Jarvis calls a stranger and makes a commitment in his name.
 *
 * FOUR RULES, AND THE FIRST IS THE ONE THE DEBUG NOTE SAYS WILL BREAK.
 *
 * ONE: **the grant is a boundary, not a target.**
 *
 *   "If it books the wrong slot when the exact one is unavailable, **the grant is
 *    being treated as a target to satisfy rather than a ceiling** — a miss is a
 *    question, not an improvisation."
 *
 * So `decideOnOffer` accepts only when the deviation list is EMPTY, and the
 * accepting branch cannot be reached with a non-empty one. Booking 8:45 when he
 * said 8:00 is a scope expansion (S10 condition 2, S42's origin rule), and the
 * whole point is that it stops.
 *
 * TWO: **it identifies, and it does not impersonate.** "*This is Jarvis, calling
 * on behalf of Enrique*" — never a claim to be him.
 *
 * THREE: **it discloses only what the task needs**, because "outbound establishes
 * nothing" and a business is a stranger. `disclosureFor` is built from a closed
 * set of booking fields; there is no field on it for anything else, so "it
 * discloses more than the task needs" is not a thing that can be written here.
 *
 * FOUR: **it never commits money and never reads out a card number.** "Reading a
 * card to a business is a prohibited financial action **regardless of how the
 * task was phrased**" — so this is not a parameter that can be granted, and the
 * disclosure type has nowhere to put one.
 */

/** Exactly what he asked for. The ceiling, not a wish list. */
export type BookingParameters = {
  when: string;
  partySize: number;
  seating?: string | null;
  underName: string;
};

/** What the business actually offered. */
export type Offer = {
  when: string;
  partySize: number;
  seating?: string | null;
  /** A card guarantee or deposit is required to hold it. */
  requiresCard?: boolean;
};

export type Deviation = { field: string; granted: string; offered: string };

/**
 * How the offer differs from what he authorised.
 *
 * Compared field by field so the deviation can be NAMED when it comes back to
 * him. "It comes back and asks" is only useful if the question says what changed;
 * "there was a problem" makes him place the call himself.
 */
export function deviationsFrom(granted: BookingParameters, offered: Offer): Deviation[] {
  const out: Deviation[] = [];
  if (norm(offered.when) !== norm(granted.when)) {
    out.push({ field: "time", granted: granted.when, offered: offered.when });
  }
  if (offered.partySize !== granted.partySize) {
    out.push({
      field: "party size",
      granted: String(granted.partySize),
      offered: String(offered.partySize),
    });
  }
  if (norm(offered.seating ?? "") !== norm(granted.seating ?? "")) {
    out.push({
      field: "seating",
      granted: granted.seating ?? "unspecified",
      offered: offered.seating ?? "unspecified",
    });
  }
  return out;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export type OfferDecision =
  | { act: "accept"; say: string }
  | { act: "stop_and_ask"; deviations: Deviation[]; say: string; reportToHim: string };

/**
 * What to do with what the restaurant just said.
 *
 * The accept branch is guarded on an EMPTY deviation list and on no card being
 * required. There is no argument that widens it — no `allowNearMatch`, no
 * tolerance — because a tolerance is how a ceiling becomes a target.
 */
export function decideOnOffer(
  granted: BookingParameters,
  offered: Offer,
): OfferDecision {
  const deviations = deviationsFrom(granted, offered);

  /*
   * Checked before the deviations, because a card is refused even when the offer
   * is otherwise exactly what he asked for. "Regardless of how the task was
   * phrased" - so it is not a deviation to be weighed, it is a stop.
   */
  if (offered.requiresCard) {
    return {
      act: "stop_and_ask",
      deviations,
      say: "I can't give card details over the phone — I'll come back to you about that.",
      reportToHim: "They want a card to hold it. I have not given them anything; do you want to call "
        + "them yourself, or shall I look elsewhere?",
    };
  }

  if (deviations.length === 0) {
    return { act: "accept", say: "That works, thank you — please hold it." };
  }

  /*
   * The field name is dropped where the value already says what it is. "They can
   * do time Saturday at 8:45pm" is what naive labelling produces, and he reads
   * these sentences - a report that reads like a form makes him place the call
   * himself to find out what actually happened.
   */
  const named = deviations
    .map((d) => (d.field === "time"
      ? `${d.offered} instead of ${d.granted}`
      : `${d.field} ${d.offered} instead of ${d.granted}`))
    .join(", and ");
  return {
    act: "stop_and_ask",
    deviations,
    /*
     * What is said ON THE CALL. It does not accept and it does not haggle: the
     * grant covers one thing and this is not it.
     */
    say: "Let me check with him and call you back, thank you.",
    reportToHim: `They can do ${named}. Do you want it?`,
  };
}

/* ------------------------------------------------------------------ *
 * Who is speaking, and what they may know.
 * ------------------------------------------------------------------ */

/**
 * The opening line.
 *
 * Constructed from the owner's name in the third person. There is no phrasing
 * here in which Jarvis is the speaker's principal, which is what "never a claim
 * to be him" means in code rather than in a prompt.
 *
 * The AI disclosure is part of the same sentence rather than a separate line that
 * could be dropped for brevity — the plan flags it as the cautious default and
 * one line of config to change, which means it has to be somewhere findable.
 */
export function openingLine(ownerName: string): string {
  return `Hello — this is Jarvis, an automated assistant calling on behalf of ${ownerName}.`;
}

/** Everything a booking call may say about him. Note what is absent. */
export type Disclosure = {
  underName: string;
  when: string;
  partySize: number;
  seating?: string | null;
};

/**
 * What the business is told.
 *
 * Built field by field from the booking parameters. There is no field for a card,
 * an address, an email, another booking, or anything else about his affairs -
 * "outbound establishes nothing, and a business is a stranger". The Debug note
 * says the failure is "applying inbound disclosure rules to an outbound
 * stranger", and the way to not do that is to have nothing else in scope.
 */
export function disclosureFor(granted: BookingParameters): Disclosure {
  return {
    underName: granted.underName,
    when: granted.when,
    partySize: granted.partySize,
    seating: granted.seating ?? null,
  };
}

/** The request, spoken. Reads only from the disclosure. */
export function requestLine(d: Disclosure): string {
  const seat = d.seating ? `, ${d.seating}` : "";
  return `I'd like a table for ${d.partySize} on ${d.when}${seat}, under the name ${d.underName}.`;
}

/* ------------------------------------------------------------------ *
 * Money.
 * ------------------------------------------------------------------ */

/**
 * Asked for a card.
 *
 * A single answer, because there is only one. This exists as a function so the
 * refusal is testable and so the sentence is written once rather than left to a
 * model that is being pressed by a stranger on a phone call.
 */
export function cardRequested(): { give: false; say: string; report: string } {
  return {
    give: false,
    say: "I'm not able to give card details. I'll pass this back and someone will call you.",
    report: "They asked for a card. I did not give one.",
  };
}

/* ------------------------------------------------------------------ *
 * Dialling.
 * ------------------------------------------------------------------ */

/** S23's discipline, applied to the other direction. */
export const MAX_ATTEMPTS = 2;

export type DialDecision =
  | { dial: true; attempt: number }
  | { dial: false; why: string; report: string };

/**
 * May this number be dialled again?
 *
 * "No answer -> S23's discipline: **does not redial in a loop**; reports back."
 * The cap is on ATTEMPTS rather than on elapsed time, because a loop that waits
 * politely between calls is still a loop from the restaurant's side.
 */
export function mayDial(attemptsSoFar: number): DialDecision {
  if (attemptsSoFar >= MAX_ATTEMPTS) {
    return {
      dial: false,
      why: `already tried ${attemptsSoFar} times`,
      report: "No answer after two tries. I've stopped rather than keep calling them.",
    };
  }
  return { dial: true, attempt: attemptsSoFar + 1 };
}

/* ------------------------------------------------------------------ *
 * Whether this call needed asking about at all.
 * ------------------------------------------------------------------ */

export type CallOrigin = "he_named_it" | "jarvis_chose_it";

/**
 * "Explicit instruction is the approval — and only for what he actually said."
 *
 * The call he asked for raises nothing: S42's rule, and asking again would be
 * "exactly the redundant friction the requirements name". A second place he did
 * not name is something Jarvis chose, and an action he did not ask for does not
 * inherit the authority of one he did.
 */
export function approvalForCall(origin: CallOrigin): { asks: boolean; why: string } {
  if (origin === "he_named_it") {
    return {
      asks: false,
      why: "he named this number and this booking, so the instruction is the approval",
    };
  }
  return {
    asks: true,
    why: "he did not name this place — calling it is something Jarvis chose, and a choice does not "
      + "inherit the authority of an instruction",
  };
}

/**
 * What is kept from the call.
 *
 * "Written to **not record the other party's audio** — the transcript comes from
 * Jarvis's own STT of its side and the reported outcome." Flagged in the plan as
 * the cautious reading of consent law and one line of config to change, so the
 * default is expressed here rather than left to whatever the dialler does.
 */
export function recordingPolicy(): {
  recordOwnSide: boolean;
  recordOtherParty: false;
  why: string;
} {
  return {
    recordOwnSide: true,
    recordOtherParty: false,
    why: "consent for recording a third party varies by jurisdiction, so the transcript is Jarvis's "
      + "own side plus the reported outcome",
  };
}
