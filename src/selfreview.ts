/**
 * Learning from the conversations themselves (plan S48, extending S34).
 *
 * The weekly Improvement cycle looks outward — new models, new tools. This makes
 * it look inward, at how Jarvis has actually been doing: mistakes, friction,
 * weak answers, capabilities that were needed and absent, and above all
 * **repeated corrections** — "the strongest signal available, because it is
 * Enrique telling Jarvis the same thing twice".
 *
 * THIS IS THE SINGLE DELIBERATE EXCEPTION TO ISOLATION IN THE WHOLE PLAN, and the
 * plan knows exactly how dangerous that is:
 *
 *   "Everything else here is scoped... **S48 is the single deliberate
 *    exception** — it reads every conversation from every surface and every
 *    project, in one pass, because the patterns worth finding only exist across
 *    them. **An exception that broad, arriving in the last step, is how isolation
 *    quietly stops meaning anything. So it needs a shape.**"
 *
 * THE SHAPE IS: FAN OUT PER PROJECT, MERGE FINDINGS, NEVER TRANSCRIPTS.
 *
 *   "The analysis runs **once per project** — and once for system scope — each
 *    under that project's own routing and auth policy... **No single context ever
 *    holds two projects' bodies.**"
 *
 * So `projectPass` is the only function here that sees a transcript, and what it
 * returns cannot carry one: `Finding` has no field for a body, a quote or an
 * excerpt. `mergeFindings` takes `Finding[]` and there is no parameter through
 * which a transcript could reach it. That absence is the mechanism — the plan's
 * test says to "**assert on what crossed between passes, not on what the report
 * says about itself**", and what crosses is a type that cannot hold one.
 *
 * AND A FINDING CITES, IT DOES NOT QUOTE. "The citation is a conversation and
 * turn reference that resolves in the console, where Enrique can already see
 * everything. **A reference carries no content.**"
 *
 * That resolves the tension the Debug note creates. The signal genuinely does
 * live in the exact words of the correction — and those words stay inside the
 * pass that read them. "**They drive the finding; they do not become its
 * payload.**"
 *
 * WHICH LEAVES ONE PROBLEM, and the Debug note names it: "if cross-project
 * repetition stops being detected once the passes are split, the finding shape is
 * carrying prose instead of a normalised correction. **Two passes describing the
 * same defect in different words will never match.**" So a correction is
 * normalised to a closed vocabulary before it leaves its pass, and matching is
 * done on that rather than on a sentence.
 */
import crypto from "node:crypto";
import { strictestOf, type Confidentiality } from "./brevity.js";

/**
 * What kind of thing was corrected.
 *
 * A closed vocabulary, and that is the whole reason cross-project matching works.
 * Two passes reading "stop calling me Enrique" and "use my first name, not my
 * full one" must produce the SAME behaviour key, or the step reports two
 * unrelated one-offs where there is one standing complaint.
 */
export const BEHAVIOURS = [
  "form_of_address",
  "message_length",
  "channel_choice",
  "asked_before_acting",
  "did_not_ask_before_acting",
  "wrong_project",
  "restated_context",
  "missing_capability",
  "weak_answer",
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

export function isBehaviour(b: string): b is Behaviour {
  return (BEHAVIOURS as readonly string[]).includes(b);
}

/**
 * A reference that resolves in the console. Note what it does not have.
 *
 * No text, no excerpt, no snippet. "A reference carries no content" — and the
 * console is where he can already see everything, so a citation that carried the
 * words would be duplicating into a less protected place what is already
 * available in a more protected one.
 */
export type Citation = {
  conversationId: string;
  turn: number;
};

/**
 * What leaves a project's pass.
 *
 * There is deliberately no `quote`, `excerpt`, `body` or `sample` field. A field
 * like that is how "merge findings, never transcripts" becomes true on Tuesday
 * and false on Thursday, because a helpful excerpt is the obvious next
 * improvement and nothing would have stopped it.
 */
export type Finding = {
  behaviour: Behaviour;
  /** Normalised, not prose. What it should be instead. */
  correctedTo: string;
  /** Which project's pass produced it. An id, not a name and not a body. */
  projectId: string | null;
  classification: Confidentiality;
  citations: Citation[];
  /** How many times inside that one project. */
  occurrences: number;
  /** Determined inside the pass, where the current behaviour can be seen. */
  alreadyFixed: boolean;
};

/**
 * The identity a correction is matched on across projects.
 *
 * Built from the closed behaviour key and a normalised target, never from the
 * sentence he actually said. Two passes that saw different words about the same
 * defect land on one fingerprint; that is the difference between one ranked
 * finding and three unrelated ones.
 */
export function correctionFingerprint(behaviour: Behaviour, correctedTo: string): string {
  const target = correctedTo.trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(`${behaviour}::${target}`).digest("hex").slice(0, 16);
}

/** A transcript, as only a project's own pass ever sees it. */
export type Transcript = {
  conversationId: string;
  projectId: string | null;
  turns: { n: number; text: string }[];
};

/**
 * One project's pass. The only place a body is read.
 *
 * Takes transcripts for ONE project — the signature is single-project on purpose,
 * so "no single context ever holds two projects' bodies" is a property of what
 * can be called rather than of how carefully it is called.
 */
export function projectPass(args: {
  projectId: string | null;
  classification: Confidentiality;
  transcripts: Transcript[];
  /** Corrections detected in this pass, already normalised by the analyser. */
  corrections: { behaviour: string; correctedTo: string; conversationId: string; turn: number }[];
  /** Behaviours whose fix has already shipped. Determined here, where it is visible. */
  fixedBehaviours?: Behaviour[];
}): Finding[] {
  const foreign = args.transcripts.filter((t) => t.projectId !== args.projectId);
  if (foreign.length) {
    /*
     * Refused rather than filtered. A pass handed another project's transcript is
     * a caller that has already made the mistake this step is shaped around, and
     * quietly dropping the extras would let it keep making it.
     */
    throw new Error(
      `a project pass was handed ${foreign.length} transcript(s) belonging to another project`,
    );
  }
  const fixed = new Set(args.fixedBehaviours ?? []);
  const byFingerprint = new Map<string, Finding>();

  for (const c of args.corrections) {
    if (!isBehaviour(c.behaviour)) continue;
    const key = correctionFingerprint(c.behaviour, c.correctedTo);
    const existing = byFingerprint.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.citations.push({ conversationId: c.conversationId, turn: c.turn });
      continue;
    }
    byFingerprint.set(key, {
      behaviour: c.behaviour,
      correctedTo: c.correctedTo.trim().toLowerCase(),
      projectId: args.projectId,
      classification: args.classification,
      citations: [{ conversationId: c.conversationId, turn: c.turn }],
      occurrences: 1,
      alreadyFixed: fixed.has(c.behaviour),
    });
  }
  return [...byFingerprint.values()];
}

export type MergedFinding = {
  behaviour: Behaviour;
  correctedTo: string;
  fingerprint: string;
  /** How many distinct projects raised it. The cross-project signal. */
  projects: number;
  occurrences: number;
  citations: Citation[];
  classification: Confidentiality;
};

/**
 * Merge what the passes produced.
 *
 * Takes findings. There is no transcript parameter, which is what the plan's
 * "assert on what crossed between passes" is asserting against.
 *
 * "Repeated corrections rank above everything else. One awkward exchange is
 * noise; **the same correction three times is a defect with a location.**" So the
 * ordering is by projects first, then occurrences — a correction appearing in
 * three projects outranks one appearing three times in one, because the first is
 * a standing complaint and the second may be one bad week on one piece of work.
 */
export function mergeFindings(passes: Finding[][]): MergedFinding[] {
  const merged = new Map<string, MergedFinding>();
  const projectsSeen = new Map<string, Set<string>>();

  for (const pass of passes) {
    for (const f of pass) {
      /*
       * "Already-fixed issues are dropped SILENTLY. A weekly report re-raising
       * last week's fixed problems is a report that gets skipped, and then the
       * real items go unread with it."
       */
      if (f.alreadyFixed) continue;
      const key = correctionFingerprint(f.behaviour, f.correctedTo);
      const seen = projectsSeen.get(key) ?? new Set<string>();
      seen.add(f.projectId ?? "system");
      projectsSeen.set(key, seen);

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          behaviour: f.behaviour,
          correctedTo: f.correctedTo,
          fingerprint: key,
          projects: seen.size,
          occurrences: f.occurrences,
          citations: [...f.citations],
          classification: f.classification,
        });
        continue;
      }
      existing.projects = seen.size;
      existing.occurrences += f.occurrences;
      existing.citations.push(...f.citations);
      /*
       * The merged finding takes the strictest classification of the projects
       * that raised it - S38's rule, because a finding spanning a confidential
       * project is about confidential work even though it carries none of it.
       */
      existing.classification = strictestOf([existing.classification, f.classification]);
    }
  }

  return [...merged.values()].sort((a, b) =>
    b.projects - a.projects || b.occurrences - a.occurrences);
}

/**
 * The classification of the weekly report.
 *
 * "This report spans all of them BY CONSTRUCTION. So it is confidential unless
 * every project it touched was normal: linked rather than attached, not read
 * aloud by S41, retained as its strictest input demands."
 *
 * S38's own function, so the report and every other document agree about what
 * mixing means.
 */
export function reportClassification(touched: Confidentiality[]): Confidentiality {
  return strictestOf(touched);
}

/**
 * The report.
 *
 * "A week with genuinely nothing wrong produces a short report saying so. **A
 * cycle that always finds problems is a cycle that invents them**, and this test
 * is what keeps it honest."
 */
export function describeWeek(findings: MergedFinding[]): string {
  if (!findings.length) {
    return "Nothing worth changing this week.";
  }
  const top = findings[0];
  const lead = top.projects > 1
    ? `The same correction came up in ${top.projects} projects: ${describe(top)}.`
    : `${capitalise(describe(top))}, ${top.occurrences} times.`;
  return findings.length === 1
    ? lead
    : `${lead} ${findings.length - 1} other${findings.length === 2 ? "" : "s"} behind it.`;
}

function describe(f: MergedFinding): string {
  return `${f.behaviour.replace(/_/g, " ")} — should be ${f.correctedTo}`;
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Where a project's pass may run.
 *
 * "A confidential project's pass runs under that project's routing. A run that
 * would have sent its body anywhere else **fails closed rather than quietly
 * downgrading** — **a fallback that silently picks another provider is the whole
 * defect wearing a retry.**"
 *
 * So there is no fallback parameter. A caller with no permitted provider
 * available gets a refusal it has to handle, not a second-best it will not notice.
 */
export function routeForPass(args: {
  classification: Confidentiality;
  /** Providers this project's policy permits. */
  permitted: string[];
  /** Providers actually up right now. */
  available: string[];
}): { provider: string } | { refused: true; why: string } {
  const usable = args.permitted.filter((p) => args.available.includes(p));
  if (!usable.length) {
    return {
      refused: true,
      why: `no provider this ${args.classification} project permits is available — the pass does not `
        + "run rather than running somewhere it may not send this",
    };
  }
  return { provider: usable[0] };
}

/**
 * "It produces work, not observations."
 *
 * "An issue that cannot be turned into a task or a preference change is not
 * carried; **it is either actionable or it is dropped.**" So a finding with no
 * action is filtered out here rather than printed and ignored.
 */
export type Actionable =
  | { action: "preference"; key: string; value: string }
  | { action: "task"; title: string }
  | null;

export function actionFor(f: MergedFinding): Actionable {
  switch (f.behaviour) {
    case "form_of_address":
      return { action: "preference", key: "comm.address_as", value: f.correctedTo };
    case "message_length":
      return { action: "preference", key: "comm.detail_level", value: f.correctedTo };
    case "channel_choice":
      return { action: "preference", key: "comm.preferred_channel", value: f.correctedTo };
    case "missing_capability":
      return { action: "task", title: `Build the capability for ${f.correctedTo}` };
    case "wrong_project":
    case "restated_context":
    case "asked_before_acting":
    case "did_not_ask_before_acting":
      return { action: "task", title: `Fix ${f.behaviour.replace(/_/g, " ")}: should be ${f.correctedTo}` };
    default:
      /*
       * `weak_answer` on its own is an observation. It becomes work only when it
       * arrives as one of the specific shapes above, which is the point: a
       * finding nobody can act on is noise dressed as insight.
       */
      return null;
  }
}
