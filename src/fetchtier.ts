/**
 * The cheapest fetch that works, and no cheaper (plan S32).
 *
 *   1. Plain HTTP — sane headers. Most APIs and static pages. Milliseconds, no RAM.
 *   2. Fingerprinted HTTP — a TLS-fingerprinting client for sites that reject
 *      stock clients on JA3/JA4 before serving any content.
 *   3. Headless browser — only for pages that genuinely need JavaScript
 *      execution or an authenticated session. **Occupies the single heavy slot
 *      (ADR 007): while a browser is scraping, no coding task runs.**
 *
 * Two things make this more than a for-loop over three functions.
 *
 * ESCALATION HAPPENS ONLY ON FAILURE. A ladder that starts at the tier it
 * guesses will be needed is a ladder that runs a browser for a static page,
 * which is the expense S32 exists to prevent - so a tier is only reached
 * because the one below it was tried and did not work, and the reason it did
 * not is recorded beside it. "Assert the escalation actually happens and is
 * recorded" is the plan's test, and a record of what was tried is what makes a
 * slow scrape explainable afterwards rather than guessed at.
 *
 * THE BROWSER CANNOT BE REACHED WITHOUT THE HEAVY SLOT. ADR 007 gives the box
 * one, and a browser that quietly takes it while a coding task is running is
 * the resource bug that looks like a scheduler fault for a week. So the browser
 * tier takes a slot token it cannot fabricate: without one it is not attempted,
 * and the ladder says so rather than reporting the site as unreachable. That is
 * the difference between "this needs a browser and we could not get one" and
 * "this site is down", which are different problems for different people.
 *
 * TIER 2 IS DECLARED AND NOT IMPLEMENTED, deliberately and visibly. The plan
 * asks Enrique which fingerprinting client he meant - "Paw HTTPS", most likely
 * pyhttpx or curl_cffi - and says the choice "determines whether the fetch tier
 * can pass fingerprint checks at all". Guessing would produce a rung that looks
 * present and fails in a way nobody could distinguish from a site problem, so
 * an unconfigured tier is SKIPPED WITH A REASON rather than counted as a
 * failure of the site. Registering it later is one function.
 */

export type Tier = "http" | "fingerprinted" | "browser";

/** The ladder, cheapest first. The order is the policy. */
export const TIER_ORDER: Tier[] = ["http", "fingerprinted", "browser"];

export type FetchOutcome =
  | { ok: true; body: string; status: number }
  /** The tier ran and the site refused it. Escalating is the right response. */
  | { ok: false; retryable: true; reason: string }
  /** The site answered and the answer is final. Escalating would be pointless. */
  | { ok: false; retryable: false; reason: string };

export type TierImpl = (url: string) => Promise<FetchOutcome>;

/**
 * Proof that the caller holds the box's single heavy slot.
 *
 * Deliberately not a boolean. A boolean is something a caller can pass `true`
 * for; this has to be handed over by whatever actually took the slot, so
 * "reached the browser without the slot" is not expressible rather than merely
 * discouraged.
 */
export type HeavySlot = { readonly heldBy: string; readonly acquiredAt: Date };

export type Attempt = {
  tier: Tier;
  outcome: "served" | "refused" | "unavailable" | "skipped";
  reason: string;
};

export type LadderResult = {
  body: string | null;
  status: number | null;
  /** Which tier answered. Null when none did. */
  servedBy: Tier | null;
  /** Every rung, in order, with why it was left. This is the record S32 asks for. */
  attempts: Attempt[];
};

export type Ladder = {
  /** Only the tiers actually configured. A missing one is skipped, not failed. */
  impls: Partial<Record<Tier, TierImpl>>;
  /** Held if the caller took it; absent means the browser tier is not reachable. */
  heavySlot?: HeavySlot | null;
  /** Never go above this rung, whatever happens. */
  ceiling?: Tier;
};

/**
 * Walk the ladder until something serves the page.
 *
 * Returns the whole attempt list even on success, because "it worked" and "it
 * worked on the third try after two refusals" cost different amounts and are
 * the same result otherwise.
 */
export async function fetchByLadder(url: string, ladder: Ladder): Promise<LadderResult> {
  const attempts: Attempt[] = [];
  const ceilingIndex = ladder.ceiling ? TIER_ORDER.indexOf(ladder.ceiling) : TIER_ORDER.length - 1;

  for (const [index, tier] of TIER_ORDER.entries()) {
    if (index > ceilingIndex) {
      attempts.push({ tier, outcome: "skipped", reason: `above the ceiling (${ladder.ceiling})` });
      continue;
    }

    /*
     * The slot check is BEFORE the implementation check, so "we could not get
     * the heavy slot" is never reported as "the browser tier is not
     * configured". They are different problems and they go to different people.
     */
    if (tier === "browser" && !ladder.heavySlot) {
      attempts.push({
        tier,
        outcome: "unavailable",
        reason: "the heavy slot is not held, and a browser takes the only one the box has",
      });
      continue;
    }

    const impl = ladder.impls[tier];
    if (!impl) {
      attempts.push({
        tier,
        outcome: "skipped",
        reason: tier === "fingerprinted"
          ? "no fingerprinting client is configured yet, so this rung cannot be tried"
          : `no ${tier} implementation is registered`,
      });
      continue;
    }

    const outcome = await impl(url);
    if (outcome.ok) {
      attempts.push({ tier, outcome: "served", reason: `HTTP ${outcome.status}` });
      return { body: outcome.body, status: outcome.status, servedBy: tier, attempts };
    }
    if (!outcome.retryable) {
      /*
       * A 404 is an answer. Escalating to a browser to be told 404 more
       * expensively is the exact shape of waste this ladder exists to avoid, so
       * a final answer stops the walk rather than climbing past it.
       */
      attempts.push({ tier, outcome: "refused", reason: `${outcome.reason} (final)` });
      return { body: null, status: null, servedBy: null, attempts };
    }
    attempts.push({ tier, outcome: "refused", reason: outcome.reason });
  }

  return { body: null, status: null, servedBy: null, attempts };
}

/**
 * One line explaining what a page cost, for the task record.
 *
 * The plan asks that "the mode and tier used are recorded on the task, so a
 * slow or costly scrape can be explained afterwards rather than guessed at".
 * A tier name alone does not explain anything - "browser" is only interesting
 * beside the two rungs that were tried first and what they said.
 */
export function explainLadder(result: LadderResult): string {
  const path = result.attempts
    .map((a) => `${a.tier}: ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`)
    .join(" → ");
  return result.servedBy
    ? `served by ${result.servedBy} — ${path}`
    : `nothing served this page — ${path}`;
}

/**
 * The plain HTTP rung.
 *
 * "Politeness by default: honest user agent unless the project's AGENTS.md says
 * otherwise." The default identifies Jarvis and gives a way to complain, which
 * is what an honest user agent is for; a project that needs something else
 * decides that in its repository rather than per task.
 */
export const HONEST_USER_AGENT = "JarvisBot/1 (+https://jarvis.enriquecodes.com/bot)";

export function httpTier(
  doFetch: typeof fetch = fetch,
  userAgent = HONEST_USER_AGENT,
): TierImpl {
  return async (url: string) => {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { "User-Agent": userAgent, Accept: "text/html,*/*" } });
    } catch (err) {
      return { ok: false, retryable: true, reason: err instanceof Error ? err.message : "the request failed" };
    }
    if (res.ok) return { ok: true, body: await res.text(), status: res.status };
    /*
     * 403 and 429 are the fingerprint-rejection shapes: a site deciding about
     * the CLIENT rather than about the page, which is exactly what the next
     * rung exists for. 404 and 410 are decisions about the page, and no client
     * changes them.
     */
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    return { ok: false, retryable, reason: `HTTP ${res.status}` };
  };
}
