/**
 * "I don't have that tool" is not an acceptable answer (plan S44).
 *
 * When a request needs a capability Jarvis lacks, it works out whether the
 * capability can reasonably be added — researches the approach, builds or
 * configures the thing, tests it, and then uses it. "The requirement is that a
 * missing capability becomes a piece of work rather than a refusal."
 *
 * THE BOUNDARY THIS FILE EXISTS TO HOLD.
 *
 *   "**So a capability Jarvis builds for itself does not land in core.** It lands
 *    as something *attachable*: an MCP server, an adapter, a configured
 *    connection, a script the runner can invoke — plugged in at runtime, not
 *    compiled into the thing doing the plugging."
 *
 *   "**If a capability genuinely cannot be built as an attachable thing** — it
 *    needs a schema change, a new lane, a change to the broker — then it is not a
 *    tool. It is a change to Jarvis... **Say so plainly rather than finding a way
 *    to express it as a plugin.**"
 *
 * So the form is DERIVED FROM WHAT IT NEEDS, never chosen. `formFor` reads the
 * requirements and returns `core_change` whenever one of them is a core
 * requirement; there is no argument through which a caller can declare something
 * attachable. The plan's test — "nothing it builds requires a core deploy to use;
 * assert this directly" — is then a property of the type rather than a habit,
 * because "finding a plugin-shaped way to express it" is exactly what a
 * caller-chosen form would permit.
 *
 * AND THE ESTIMATE IS NOT OPTIONAL. The Debug note is unusually direct: "if it
 * starts building for every gap, the cost estimate is missing. **Building a tool
 * is sometimes the wrong answer and the estimate is what makes that visible.**"
 * A proposal without one is refused here, and an expensive one has to carry the
 * cheaper alternative — "*I could build that but it would take a week and here is
 * the cheaper alternative*" is named as the right answer far more often than
 * either extreme.
 *
 * WHAT IT DOES NOT GET FOR BEING HOMEGROWN: any trust at all. "A new tool goes
 * through the same classification as any other (S31): blast radius decided at
 * build time, by a person, before it is callable. A capability Jarvis wrote for
 * itself is not more trusted for being homegrown — **if anything it is less,
 * because nobody else has ever run it.**"
 */

/** The four shapes a capability can take without touching core. */
export const ATTACHABLE_FORMS = ["mcp_server", "adapter", "connection", "script"] as const;
export type AttachableForm = (typeof ATTACHABLE_FORMS)[number];

export type CapabilityForm = AttachableForm | "core_change";

/**
 * Things that cannot be plugged in at runtime.
 *
 * The plan names the first three; the rest are the same kind of thing. Each one
 * is a change to the machine rather than something the machine loads, and the
 * test of that is simple: could the runner pick this up without `jarvis-core`
 * being rebuilt? A migration cannot. A new queue state cannot.
 */
export const CORE_REQUIREMENTS = [
  "schema_change",
  "migration",
  "new_lane",
  "broker_change",
  "new_queue_state",
  "safety_surface",
] as const;
export type CoreRequirement = (typeof CORE_REQUIREMENTS)[number];

export function isCoreRequirement(r: string): r is CoreRequirement {
  return (CORE_REQUIREMENTS as readonly string[]).includes(r);
}

/**
 * Over this, an estimate needs an alternative beside it.
 *
 * Not a refusal threshold — he may well want the week's work. It is the point at
 * which handing him only the expensive option stops being a proposal and starts
 * being a decision made on his behalf.
 */
export const EXPENSIVE_DAYS = 3;

export type CapabilityRequest = {
  /** What he asked for that Jarvis cannot currently do. */
  need: string;
  /** What building it would actually require. Facts, not a chosen shape. */
  requirements: string[];
  /** Which attachable shape it would take, if it is attachable at all. */
  shape?: AttachableForm;
  /** Days. Required — see the Debug note. */
  estimateDays?: number;
  /** The cheaper way, when there is one. */
  alternative?: string | null;
  /** A provider that would have to be signed up for and paid. */
  newProvider?: string | null;
  /** The project this is being built for. Isolation follows from it. */
  projectId: string | null;
};

export type Proposal =
  | {
    verdict: "attachable";
    form: AttachableForm;
    estimateDays: number;
    alternative: string | null;
    say: string;
  }
  | {
    verdict: "core_change";
    form: "core_change";
    /** Which requirements put it here, so the answer is checkable. */
    because: CoreRequirement[];
    estimateDays: number;
    say: string;
  }
  | {
    verdict: "needs_provider";
    provider: string;
    estimateDays: number;
    say: string;
  }
  | { verdict: "no_estimate"; say: string };

/**
 * What shape this would take, read off what it needs.
 *
 * There is deliberately no way for a caller to assert "this is an MCP server"
 * over requirements that say otherwise. That asymmetry is the whole point: the
 * failure the plan names is "finding a plugin-shaped way to express" a core
 * change, and it is only possible where the form is an input.
 */
export function formFor(requirements: string[], shape?: AttachableForm): CapabilityForm {
  if (requirements.some(isCoreRequirement)) return "core_change";
  return shape ?? "script";
}

/**
 * Answer a request for something Jarvis cannot do.
 *
 * Never a refusal, and never a silent start. The order below is the order the
 * plan gives: no estimate is not a proposal at all; a new paid provider is a
 * recommendation whatever the shape; a core change says so plainly; and only
 * then is it a tool.
 */
export function proposeCapability(req: CapabilityRequest): Proposal {
  /*
   * "If it starts building for every gap, the cost estimate is missing." First,
   * because without it none of the answers below can be judged.
   */
  if (typeof req.estimateDays !== "number" || !Number.isFinite(req.estimateDays)) {
    return {
      verdict: "no_estimate",
      say: `I can't tell you what ${req.need} would cost yet — let me look at it before I say yes.`,
    };
  }
  const days = req.estimateDays;
  const form = formFor(req.requirements, req.shape);

  /*
   * "New provider, new billing, new trust relationship -> recommendation and
   * approval, NEVER self-service." Checked before the form, because a signup is
   * a signup whether the code that follows is a plugin or not.
   */
  if (req.newProvider) {
    return {
      verdict: "needs_provider",
      provider: req.newProvider,
      estimateDays: days,
      say: `${capitalise(req.need)} needs an account with ${req.newProvider}, which is your call and `
        + `not mine to open. About ${dayish(days)} once it exists.`
        + (req.alternative ? ` ${capitalise(req.alternative)} would avoid it.` : ""),
    };
  }

  if (form === "core_change") {
    const because = req.requirements.filter(isCoreRequirement);
    return {
      verdict: "core_change",
      form: "core_change",
      because,
      estimateDays: days,
      /*
       * "Say so plainly rather than finding a way to express it as a plugin."
       * Naming the requirements makes the claim checkable rather than a
       * judgement he has to take on trust.
       */
      say: `${capitalise(req.need)} isn't a tool — it needs ${because.join(" and ")}, so it's a change `
        + `to Jarvis itself and goes through the staged deploy. About ${dayish(days)}.`,
    };
  }

  /*
   * "I could build that but it would take a week and here is the cheaper
   * alternative is the right answer far more often than either extreme." So an
   * expensive proposal that carries no alternative is not finished.
   */
  const alternative = req.alternative ?? null;
  const say = days > EXPENSIVE_DAYS && alternative
    ? `I can build that as ${article(form)} — about ${dayish(days)}. ${capitalise(alternative)} would be `
      + "quicker if it covers enough of it."
    : `I can build that as ${article(form)} — about ${dayish(days)}.`;

  return { verdict: "attachable", form, estimateDays: days, alternative, say };
}

/**
 * Would using this require jarvis-core to be rebuilt?
 *
 * The plan says to assert this directly, so it is a function rather than a
 * comment. Every attachable form is loaded by the runner at call time; only a
 * core change is compiled into the thing doing the loading.
 */
export function needsCoreDeploy(form: CapabilityForm): boolean {
  return form === "core_change";
}

/**
 * May the built capability be called yet?
 *
 * No, until a person has classified it — S31's rule, unchanged, and applied to
 * Jarvis's own work for the reason the plan gives: "a capability Jarvis wrote for
 * itself is not more trusted for being homegrown; if anything it is less, because
 * nobody else has ever run it."
 *
 * And isolation is not a second question. The capability was built FOR a project,
 * and a call from anywhere else is denied — the same rule S5 applies to every
 * other connection, not a new one written for homegrown tools.
 */
export function mayCall(args: {
  form: CapabilityForm;
  /** Null until a person has assigned a blast radius. */
  level: number | null;
  /** The manifest that was classified, and the manifest now. */
  classifiedHash: string | null;
  manifestHash: string;
  builtForProject: string | null;
  callingFromProject: string | null;
}): { allowed: boolean; why: string } {
  if (args.form === "core_change") {
    return { allowed: false, why: "a core change is not a tool and is not callable as one" };
  }
  if (args.level === null) {
    return {
      allowed: false,
      why: "nobody has classified this yet — a tool Jarvis wrote gets the scrutiny a stranger's would",
    };
  }
  if (args.classifiedHash !== args.manifestHash) {
    return {
      allowed: false,
      why: "the tool has changed since it was classified, so the classification is about something else",
    };
  }
  if (args.builtForProject !== args.callingFromProject) {
    return {
      allowed: false,
      why: "this was built for another project, and a capability does not travel between them",
    };
  }
  return { allowed: true, why: "classified, unchanged, and called from the project it was built for" };
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * These sentences are what he reads, so they have to sound like sentences.
 *
 * "a mcp server" is what a first-letter vowel test produces, and it is wrong for
 * the same reason "a hour" is: the article follows the SOUND. MCP is said
 * em-see-pee, so it takes "an" while starting with a consonant.
 */
const SPOKEN: Record<AttachableForm, string> = {
  mcp_server: "an MCP server",
  adapter: "an adapter",
  connection: "a configured connection",
  script: "a script the runner can invoke",
};

function article(form: AttachableForm): string {
  return SPOKEN[form];
}

function dayish(days: number): string {
  if (days <= 0.5) return "half a day";
  if (days <= 1) return "a day";
  if (days >= 5) return `${Math.round(days / 5)} week${days >= 10 ? "s" : ""}`;
  return `${days} days`;
}
