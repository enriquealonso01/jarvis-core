/**
 * What kind of failure was that? (plan S11)
 *
 * Every dirty exit used to be `harness.crash`, which is the taxonomy's
 * "respawn and retry three times" class. That is the right answer for a
 * genuinely crashed process and the wrong one for four of the five failures S11
 * names: retrying a run three times because the subscription hit its limit
 * spends the limit three times over and still parks, and retrying because the
 * disk is full fills it faster.
 *
 * So the class is decided from what the run actually said, and the class
 * carries its own retry policy from ERROR_TAXONOMY.md rather than every failure
 * sharing one.
 *
 * The matching is deliberately conservative. Anything unrecognised stays
 * `harness.crash`, because a wrong specific class is worse than a right generic
 * one: it sends the operator looking at the wrong thing.
 */

export type FailureClass =
  | "provider.cred_expired"
  | "model.rate_limit"
  | "network.timeout"
  | "resource.disk"
  | "process.stuck"
  | "agent.loop"
  | "harness.crash"
  // S18b: three classes that were in ERROR_TAXONOMY.md and in no code.
  | "resource.cpu"
  | "dependency.unavailable"
  | "agent.repeat";

export type FailureVerdict = {
  errorClass: FailureClass;
  /** Park for Enrique rather than fail terminally — nothing here is retryable by us. */
  park: boolean;
  /**
   * Where a parked task waits.
   *
   * Not one state for everything: `waiting_for_provider` means a credential or
   * quota problem and nothing else. A full disk or a looping agent parked there
   * would send whoever reads the queue to check the wrong thing.
   */
  parkState: "waiting_for_provider" | "waiting_for_user" | "stalled";
  /** Retries the taxonomy allows for this class. 0 means do not retry. */
  maxRetries: number;
  /** What to tell him, in one line. */
  summary: string;
};

/**
 * Ordered most specific first. A subscription limit often ALSO mentions
 * "request failed", so whichever pattern is checked first wins — and the
 * specific one has to.
 */
const PATTERNS: { cls: FailureClass; re: RegExp; summary: string }[] = [
  {
    cls: "provider.cred_expired",
    re: /usage limit|quota exceeded|subscription.{0,20}(limit|expired)|plan limit|credit balance|insufficient_quota|billing/i,
    summary: "the model subscription hit its limit",
  },
  {
    cls: "provider.cred_expired",
    re: /\b401\b|unauthor|invalid[_ ]api[_ ]key|authentication[_ ]error|not logged in|please run .*login|credentials? (expired|invalid|revoked)/i,
    summary: "the harness credential is not usable",
  },
  {
    cls: "model.rate_limit",
    re: /\b429\b|rate[ _]limit|too many requests|retry-after/i,
    summary: "the provider rate-limited the run",
  },
  {
    cls: "resource.disk",
    re: /ENOSPC|no space left|disk (is )?full|quota exceeded on disk/i,
    summary: "the disk is full",
  },
  {
    /*
     * An unreachable registry is NOT `network.timeout` and NOT `harness.crash`.
     * The network is fine and so is the harness — a package is gone, a lockfile
     * points at something yanked, a registry is down. Retrying helps for a
     * while and then stops helping, so it retries and then parks NAMING the
     * registry rather than reporting a build failure nobody can act on.
     *
     * Ordered before network.timeout on purpose: a failed install prints
     * ECONNREFUSED too, and the generic class would swallow the specific one.
     */
    cls: "dependency.unavailable",
    re: /ERR_PNPM_[A-Z_]*|npm ERR!|E404.*registry|could not resolve dependency|no matching version found|registry\.npmjs\.org|pypi\.org.*(404|not found)|Unable to locate package|failed to fetch.*(deb|apt)/i,
    summary: "a dependency could not be fetched",
  },
  {
    /*
     * Sustained CPU saturation. On a one-heavy-slot box it makes everything slow
     * without anything failing, which is the hardest state to diagnose from
     * tickets — the run does not error, it just never finishes.
     */
    cls: "resource.cpu",
    re: /cpu (is )?(saturated|pegged|at 100)|load average.{0,20}(1[0-9]|[2-9][0-9])\.|out of cpu|cpu quota exceeded/i,
    summary: "the box is CPU-bound",
  },
  {
    cls: "network.timeout",
    re: /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|network (is )?unreachable|getaddrinfo|socket hang up|fetch failed/i,
    summary: "the network was unreachable",
  },
];

/** Retry budgets, from ERROR_TAXONOMY.md. */
const POLICY: Record<FailureClass, { park: boolean; maxRetries: number; parkState: FailureVerdict["parkState"] }> = {
  // "no retry; UserActionRequest" — retrying cannot help and costs the limit again.
  "provider.cred_expired": { park: true, maxRetries: 0, parkState: "waiting_for_provider" },
  "model.rate_limit": { park: false, maxRetries: 5, parkState: "waiting_for_provider" },
  "network.timeout": { park: false, maxRetries: 5, parkState: "waiting_for_user" },
  // "no retry; prune temps; Issue before destructive"
  "resource.disk": { park: true, maxRetries: 0, parkState: "waiting_for_user" },
  "process.stuck": { park: false, maxRetries: 3, parkState: "stalled" },
  // "shed embeddings/browser; defer heavy start" — worth retrying, because the
  // load that caused it is usually somebody else's and passes.
  "resource.cpu": { park: false, maxRetries: 3, parkState: "stalled" },
  // "retry with backoff; then park with the registry and package named."
  "dependency.unavailable": { park: false, maxRetries: 4, parkState: "waiting_for_user" },
  // "stall; Issue with the repeated action quoted." Never retried: a run that is
  // repeating itself will repeat itself again, and each repetition costs a
  // subscription call to produce the same non-progress.
  "agent.repeat": { park: true, maxRetries: 0, parkState: "stalled" },
  // "no retry; stall; Issue" — a looping agent loops again.
  "agent.loop": { park: true, maxRetries: 0, parkState: "stalled" },
  "harness.crash": { park: false, maxRetries: 3, parkState: "waiting_for_user" },
};

export function classifyHarnessFailure(args: {
  stopReason: "cancelled" | "silent" | "timeout" | "repeat" | null;
  exitCode: number | null;
  subtype?: string | null;
  result?: string | null;
  stderr?: string | null;
}): FailureVerdict {
  // The runner already knows these two from its own timers; they are not
  // guesses from text and they win.
  if (args.stopReason === "silent") {
    return { errorClass: "process.stuck", ...POLICY["process.stuck"], summary: "the harness went silent" };
  }
  if (args.stopReason === "timeout") {
    return { errorClass: "agent.loop", ...POLICY["agent.loop"], summary: "the run exceeded its limit" };
  }
  /*
   * Distinct from agent.loop, and the distinction is the point. A loop never
   * terminates; a repeat IS emitting progress events — they are simply all the
   * same one. Identical progress is not progress, and without this class the
   * liveness-versus-progress check has nothing to raise.
   */
  if (args.stopReason === "repeat") {
    return {
      errorClass: "agent.repeat",
      ...POLICY["agent.repeat"],
      summary: "the run kept doing the same thing",
    };
  }

  const haystack = [args.subtype ?? "", args.result ?? "", args.stderr ?? ""].join("\n");
  for (const p of PATTERNS) {
    if (p.re.test(haystack)) {
      return { errorClass: p.cls, ...POLICY[p.cls], summary: p.summary };
    }
  }
  return {
    errorClass: "harness.crash",
    ...POLICY["harness.crash"],
    summary: `the harness exited ${args.exitCode ?? "abnormally"}`,
  };
}

/**
 * Has this task used up the retries its failure class allows?
 *
 * Counted from attempts that failed with the SAME class. A task that crashed
 * twice and then hit a rate limit has not used its rate-limit budget, and
 * counting all failures together would retire it early.
 */
export function retriesExhausted(sameClassFailures: number, verdict: FailureVerdict): boolean {
  return sameClassFailures >= verdict.maxRetries;
}
