/**
 * The gate inside the browser agent (plan S32, Mode 1).
 *
 * The step's own framing, and it is the reason this file exists at all:
 *
 *   "Mode 1 is an authorization bypass, and must be built as one. Everything
 *    the broker gates can be done by clicking. IV.6 puts production deploys,
 *    deletions, purchases, sending external mail, rotating credentials and
 *    changing infrastructure behind always-confirm. All of those checks live in
 *    the broker, on typed calls. A model driving a browser makes none of those
 *    calls — it clicks a button in somebody's dashboard, and the broker never
 *    hears about it."
 *
 * So the gate cannot live in the broker for this route; it has to live at the
 * click. Everything here follows from one asymmetry the plan states outright:
 *
 *   "When the classifier is unsure, it stops. A false stop costs one message; a
 *    false proceed cannot be undone by definition."
 *
 * That is not a tuning parameter. It is why every branch below that cannot
 * prove an interaction is read-only returns `approval_required`, and why the
 * unknown-element case is a stop rather than a pass. A gate that guesses in the
 * permissive direction is a gate that has already let the one click through
 * that mattered.
 *
 * WHAT THIS IS NOT: it is not a model call, and it must not become one. The
 * decision is made from the page's own structure - the method, the element, the
 * label - by rules that can be read and argued with. A model asked "is this
 * button dangerous?" is being asked to judge text written by the site, which is
 * the same mistake as letting a tool description set its own blast radius
 * (S31). A page that wants a destructive button to look harmless will always
 * win that argument; it cannot change what an HTTP method is.
 *
 * STILL OUTSTANDING, and stated rather than buried: the plan opens S32 with
 * "Write ADR 016 before any code — this has never been designed." That number
 * is already taken (016 is per-project unix users), and `docs/` is not the
 * Builder's to write, so the design record for this step does not exist yet.
 * This file carries the reasoning; it is not a substitute for the ADR.
 */

/** What the agent is about to do. */
export type Interaction = {
  url: string;
  kind: "navigate" | "read" | "screenshot" | "click" | "type" | "submit" | "select";
  /** The element as the page describes it: "button", "a", "input[type=submit]". */
  element?: string | null;
  /** What a person would read on it. Empty or missing is the ambiguous case. */
  label?: string | null;
  /** For a link or a form: where it goes and how. */
  destination?: string | null;
  method?: string | null;
  /**
   * Whether this page belongs to a production system.
   *
   * "Never on a production system without the same live approval a deploy would
   * need. The surface being a web page changes nothing about what is behind it."
   */
  production?: boolean;
};

export type Decision = {
  decision: "allow" | "approval_required";
  reason: string;
  /** Which rule decided, so a wrong call is traceable to a rule. */
  rule: string;
};

/**
 * Words that mean the thing behind the button does not come back.
 *
 * Deliberately generous, and matched against the LABEL rather than used to
 * prove safety: a match stops, a non-match proves nothing on its own and the
 * rules below still have to find a reason to allow. That asymmetry is what
 * keeps this from being a blocklist - a blocklist that misses a word lets the
 * click through, and this one does not get to make that decision alone.
 */
const DESTRUCTIVE = /\b(delete|remove|destroy|drop|erase|wipe|terminate|revoke|deactivate|disable|cancel|unsubscribe|reset|purge|archive|shut ?down|close account)\b/i;

/** Money leaving, which the plan lists beside deletion for the same reason. */
const PURCHASING = /\b(buy|purchase|pay|checkout|order|subscribe|upgrade|renew|confirm payment|place order|donate|transfer)\b/i;

/** Reaching other people, which cannot be recalled either. */
const OUTBOUND = /\b(send|publish|post|share|invite|submit for review|deploy|release|merge)\b/i;

/**
 * Labels that say nothing about what will happen.
 *
 * "A page whose only control is ambiguous → it stops rather than guessing."
 * These are the labels that appear on both a save button and a delete
 * confirmation, so reading one tells you nothing at all.
 */
const AMBIGUOUS = /^(ok|okay|go|continue|next|proceed|yes|confirm|apply|done|submit|→|>|»|\.\.\.)$/i;

const READ_ONLY_KINDS = new Set(["navigate", "read", "screenshot"]);

/**
 * Decide, from the page's structure, whether this needs a person.
 *
 * Pure: no database, no model, no network. It is the whole of the policy and it
 * can be argued with by reading it, which is the point - a gate that requires
 * running the system to find out what it does is a gate nobody audits.
 */
export function classifyInteraction(i: Interaction): Decision {
  const label = (i.label ?? "").trim();
  const method = (i.method ?? "").trim().toUpperCase();

  /*
   * Production first, before anything is allowed for being read-only. Reading
   * is genuinely safe anywhere, but this ordering means a later edit that adds
   * a permissive branch cannot accidentally sit above the production rule.
   */
  if (i.production && !READ_ONLY_KINDS.has(i.kind)) {
    return {
      decision: "approval_required",
      rule: "production",
      reason: "this is a production system, and interacting with one needs the same approval a deploy would",
    };
  }

  if (READ_ONLY_KINDS.has(i.kind)) {
    return {
      decision: "allow",
      rule: "read-only",
      reason: `${i.kind} changes nothing`,
    };
  }

  /*
   * Every form submit, whatever it says on it. The plan lists "form submits"
   * unconditionally alongside destructive labels, and it is right to: a form is
   * the mechanism by which a page changes state, and its button frequently says
   * "Save".
   */
  if (i.kind === "submit") {
    return {
      decision: "approval_required",
      rule: "submit",
      reason: `submitting a form changes something on the far side${label ? ` ("${label}")` : ""}`,
    };
  }

  if (method && method !== "GET" && method !== "HEAD") {
    return {
      decision: "approval_required",
      rule: "method",
      reason: `${method} is not a read`,
    };
  }

  if (i.kind === "click" || i.kind === "select") {
    if (!label) {
      return {
        decision: "approval_required",
        rule: "unlabelled",
        reason: "the control has no label, so there is nothing to judge it by",
      };
    }
    if (AMBIGUOUS.test(label)) {
      return {
        decision: "approval_required",
        rule: "ambiguous",
        reason: `"${label}" appears on a save button and on a delete confirmation alike`,
      };
    }
    for (const [re, what] of [[DESTRUCTIVE, "destructive"], [PURCHASING, "purchasing"], [OUTBOUND, "outbound"]] as const) {
      if (re.test(label) || (i.destination && re.test(i.destination))) {
        return {
          decision: "approval_required",
          rule: what,
          reason: `"${label}" reads as ${what === "outbound" ? "something that reaches other people" : what}`,
        };
      }
    }
    /*
     * A plain GET link with a label that says what it does. This is the only
     * branch that lets an interaction through, and it is narrow on purpose:
     * everything that could not be shown to be a read has already stopped.
     */
    return {
      decision: "allow",
      rule: "plain-navigation",
      reason: `"${label}" is a plain GET with a label that describes it`,
    };
  }

  if (i.kind === "type") {
    /*
     * Typing changes nothing on the far side until something is submitted, and
     * the submit is gated. Kept as its own branch rather than folded into the
     * read-only set so that the reasoning is visible: it is allowed because the
     * NEXT step stops, not because typing is inherently safe.
     */
    return {
      decision: "allow",
      rule: "type-before-submit",
      reason: "typing changes nothing until a submit, and the submit stops",
    };
  }

  // Unreachable for the kinds above, and deliberately a stop rather than a
  // throw: a new interaction kind added later without a rule gets the safe
  // answer instead of an exception nobody handles.
  return {
    decision: "approval_required",
    rule: "unknown-kind",
    reason: `nothing here knows what "${i.kind}" does`,
  };
}

export type GateOutcome = {
  performed: boolean;
  decision: Decision;
  actionId: string | null;
};

/**
 * Decide, record, and only then act.
 *
 * The recording happens for allowed actions too - the account of how the agent
 * reached a page is what makes the one gated action interpretable afterwards.
 *
 * `perform` is passed in rather than imported so that this module never touches
 * a browser: the policy is testable without one, which is the difference
 * between a gate that is exercised on every run and one that is exercised when
 * somebody sets up Playwright.
 */
export async function gatedInteraction(
  pool: import("pg").Pool,
  args: {
    projectId: string | null;
    taskId?: string | null;
    interaction: Interaction;
    approvalId?: string | null;
    /** Evidence, captured by the caller before and after. */
    beforeArtifactId?: string | null;
    afterArtifactId?: string | null;
  },
  perform: () => Promise<void>,
): Promise<GateOutcome> {
  const i = args.interaction;
  const decision = classifyInteraction(i);

  /*
   * An approval satisfies a stop; it does not turn one into an allow. The row
   * keeps `approval_required` with the approval beside it, because "this needed
   * a person and got one" and "this never needed anyone" are different facts
   * and only one of them is reassuring in an audit.
   */
  const needsApproval = decision.decision === "approval_required";
  const proceed = !needsApproval || Boolean(args.approvalId);

  const row = await pool.query<{ id: string }>(
    `INSERT INTO browser_actions
       (project_id, task_id, url, kind, element, label, method, destination,
        decision, reason, rule, approval_id, before_artifact_id, after_artifact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [args.projectId, args.taskId ?? null, i.url, i.kind, i.element ?? null, i.label ?? null,
      i.method ?? null, i.destination ?? null,
      proceed ? decision.decision : "refused",
      proceed ? decision.reason : `${decision.reason}; no approval was attached`,
      decision.rule, args.approvalId ?? null,
      args.beforeArtifactId ?? null, args.afterArtifactId ?? null],
  );

  if (!proceed) return { performed: false, decision, actionId: row.rows[0].id };
  await perform();
  return { performed: true, decision, actionId: row.rows[0].id };
}
