/**
 * Turning recorded benchmark runs into a ranking, and a floor (plan S29, VI.2).
 *
 * The plan is specific about what this may not do: *"set it from observed
 * scores rather than picking a round number first"*, and *"wild variance means
 * the suite is measuring noise and needs more cases before anyone trusts it"*.
 * Both of those are refusals, so both are implemented as refusals — this module
 * returns `null` and says why far more often than it returns a number.
 *
 * That is the point. A ranking computed from three runs of one case is not a
 * weaker ranking, it is a wrong one, and a floor derived from it would be an
 * opinion wearing a decimal point. The whole reason S29 exists is that routing
 * currently follows someone's guess; replacing that guess with an arithmetic
 * mean of noise would change nothing except how defensible it looks.
 */

export type BenchRow = {
  harness: string;
  suite: string;
  overall: number | null;
  scores: Record<string, number | null>;
  /** When the run happened. Needed to tell one corpus generation from another. */
  ranAt?: Date;
};

/**
 * Only the runs that faced the corpus as it stands now.
 *
 * The ranking pooled every run ever recorded, and that is how it came to
 * certify. Measured on 2026-09-03: over all 90 runs the leader was 2.63
 * standard errors clear, but split at the point the corpus reached five cases,
 * the EARLY runs give 6/11 against 2/12 and the later ones 21/34 against 13/33.
 * Almost the whole margin lives in the early era - the same era whose runs were
 * made while four harness defects, since fixed, were costing the trailing
 * engine points: a seed that could not load, a push instruction it had no
 * credential for, and bookkeeping files counted against its scope.
 *
 * So the widest window is not the most evidence, it is the most contaminated
 * evidence, and pooling it answers a question nobody asked - how the engines
 * compare across a corpus and a harness that no longer exist. Three times
 * tonight a wider window was the only one that cleared the bar and the claim
 * was withheld by hand; this puts that judgement in the code, where it applies
 * whether or not anyone remembers to make it.
 *
 * The boundary is derived, not chosen: the first run of the most recently added
 * case. Every current case had to exist for a run to be comparable, so adding a
 * sixth case moves the window on its own and cannot be tuned after seeing the
 * result. Runs of cases no longer in the corpus are dropped for the same
 * reason. Rows without a timestamp are kept, so callers that do not select one
 * behave as they did before.
 */
export function comparableRuns(rows: BenchRow[], corpus: string[]): BenchRow[] {
  const current = new Set(corpus);
  const inCorpus = rows.filter((r) => current.has(r.suite));
  const firstRunOf = new Map<string, number>();
  for (const r of inCorpus) {
    if (!r.ranAt) continue;
    const t = r.ranAt.getTime();
    const seen = firstRunOf.get(r.suite);
    if (seen === undefined || t < seen) firstRunOf.set(r.suite, t);
  }
  // Every case must have been present. If one has never run, there is no
  // window in which the corpus was whole, so nothing is comparable yet.
  if (firstRunOf.size < current.size) return [];
  const boundary = Math.max(...firstRunOf.values());
  return inCorpus.filter((r) => !r.ranAt || r.ranAt.getTime() >= boundary);
}

export type HarnessSummary = {
  harness: string;
  runs: number;
  cases: string[];
  mean: number;
  min: number;
  max: number;
  /** max - min. The plan's "wild variance" check reads this. */
  spread: number;
  /** Mean per dimension, over the runs where it was scored at all. */
  perDimension: Record<string, number>;
};

/** Why a ranking or floor was refused, in words a person can act on. */
export type Refusal = { ok: false; reason: string };

export const MIN_RUNS_PER_HARNESS = 4;
export const MIN_CASES = 3;
/**
 * Two harnesses whose means differ by less than this are not ordered.
 *
 * Set from what the suite has actually shown about itself rather than chosen:
 * the widest spread observed within a single harness on a single case was 0.072
 * (claude, 2026-09-03). A difference smaller than one harness's own run-to-run
 * wobble is not a difference, and calling it one is how a benchmark starts
 * laundering noise into decisions.
 */
export const TIE_BAND = 0.072;

export function summarise(rows: BenchRow[]): HarnessSummary[] {
  const byHarness = new Map<string, BenchRow[]>();
  for (const r of rows) {
    if (r.overall === null) continue;
    const list = byHarness.get(r.harness) ?? [];
    list.push(r);
    byHarness.set(r.harness, list);
  }

  const out: HarnessSummary[] = [];
  for (const [harness, list] of byHarness) {
    const overalls = list.map((r) => r.overall as number);
    const dims = new Map<string, number[]>();
    for (const r of list) {
      for (const [k, v] of Object.entries(r.scores)) {
        if (v === null || typeof v !== "number") continue;
        // quota_consumed is recorded, never scored - averaging it here would
        // quietly reintroduce "cheaper is better" through the summary.
        if (k === "quota_consumed") continue;
        dims.set(k, [...(dims.get(k) ?? []), v]);
      }
    }
    const perDimension: Record<string, number> = {};
    for (const [k, vs] of dims) perDimension[k] = vs.reduce((a, b) => a + b, 0) / vs.length;

    out.push({
      harness,
      runs: list.length,
      cases: [...new Set(list.map((r) => r.suite))].sort(),
      mean: overalls.reduce((a, b) => a + b, 0) / overalls.length,
      min: Math.min(...overalls),
      max: Math.max(...overalls),
      spread: Math.max(...overalls) - Math.min(...overalls),
      perDimension,
    });
  }
  return out.sort((a, b) => b.mean - a.mean);
}

/**
 * Who won, or why nobody did.
 *
 * A tie is a real answer and the common one early on. Reporting the top of a
 * sorted list as "the winner" when the gap is inside the noise band is the
 * single easiest way for this suite to hand routing a fabricated result.
 */
export function rank(rows: BenchRow[]):
  | { ok: true; winner: string; order: HarnessSummary[]; margin: number }
  | Refusal {
  const s = summarise(rows);
  if (s.length < 2) return { ok: false, reason: "only one harness has results; nothing to rank" };

  const thin = s.filter((h) => h.runs < MIN_RUNS_PER_HARNESS);
  if (thin.length) {
    return {
      ok: false,
      reason: `not enough runs to rank: ${thin.map((h) => `${h.harness} has ${h.runs} of ${MIN_RUNS_PER_HARNESS}`).join(", ")}`,
    };
  }
  const narrow = s.filter((h) => h.cases.length < MIN_CASES);
  if (narrow.length) {
    return {
      ok: false,
      reason: `not enough cases to rank: ${narrow.map((h) => `${h.harness} ran ${h.cases.length} of ${MIN_CASES}`).join(", ")}`,
    };
  }

  const margin = s[0].mean - s[1].mean;
  if (margin < TIE_BAND) {
    return {
      ok: false,
      reason: `too close to call: ${s[0].harness} ${s[0].mean.toFixed(3)} and ${s[1].harness} `
        + `${s[1].mean.toFixed(3)} differ by ${margin.toFixed(3)}, inside the ${TIE_BAND} noise band`,
    };
  }
  return { ok: true, winner: s[0].harness, order: s, margin };
}

/**
 * The score below which a model may not serve a role unattended.
 *
 * Derived, not chosen: the worst run the winning harness actually produced.
 * That is a number the suite has watched a competent run survive, which is the
 * only claim a floor can honestly make. Refused entirely until there is a
 * winner to derive it from - a floor set during a tie would be a floor set from
 * whichever contestant happened to sort first.
 */
export function proposeFloor(rows: BenchRow[]): { ok: true; floor: number; basis: string } | Refusal {
  const r = rank(rows);
  if (!r.ok) return { ok: false, reason: `no floor: ${r.reason}` };
  const winner = r.order[0].harness;

  /*
   * Derived from runs that actually solved something.
   *
   * This was the winner's worst run of any kind, and that put the floor inside
   * the wrong cluster. The scores are bimodal and cleanly so: every run that
   * passed the withheld suite scored 0.96 to 1.00, every run that failed it
   * scored 0.67 to 0.74, and nothing has ever landed between. So "the winner's
   * worst run" is a run that did NOT solve the problem, and the floor derived
   * from it sat 0.009 above a scripted fraud that fixed nothing - a floor that
   * admits work indistinguishable from fluent fraud is not a floor.
   *
   * The gap between the clusters is where it belongs, and the honest way to
   * land there is to derive it from runs that passed the tests they never saw.
   * Refused when the winner has none: a suite that has not yet watched anyone
   * solve a case has no idea what solving looks like, and any number it named
   * would be describing failure.
   */
  const solved = rows.filter(
    (x) => x.harness === winner && x.overall !== null && x.scores.hidden_tests === 1,
  );
  if (!solved.length) {
    return {
      ok: false,
      reason: `no floor: no run by ${winner} passed the withheld suite, so nothing here shows what solving looks like`,
    };
  }
  const floor = Math.min(...solved.map((x) => x.overall as number));
  return {
    ok: true,
    floor,
    basis: `the lowest of ${solved.length} runs by ${winner} that passed the withheld suite`,
  };
}

/**
 * Does a second pass reproduce the first pass's result?
 *
 * The plan asks one thing of this: *"Re-run the same pair twice: scores should
 * be close. Wild variance means the suite is measuring noise and needs more
 * cases before anyone trusts it."* It is a variance check.
 *
 * The first version demanded that EACH pass independently reach significance,
 * which is a stricter thing than the plan asks and, at this corpus size, an
 * impossible one: a pass is five cases, so five runs per engine, and five runs
 * cannot clear two standard errors no matter how cleanly they separate. Both
 * passes of the first real campaign returned identical rates - 3/5 against 2/5,
 * twice - and were both refused for want of power. A check that refuses
 * identical results is measuring its own sample size.
 *
 * So the question is asked in two parts, which is what the plan's two sentences
 * actually say:
 *
 *  - is there a ranking at all, on everything? (the pooled runs must clear the
 *    significance bar - this is the part that must not be relaxed)
 *  - do the passes agree? (same leader, and rates close rather than wild)
 *
 * Recorded plainly because loosening a failing check is exactly what a suite
 * should never do quietly: what changed is which question is asked of each
 * pass, and the requirement that the overall result be significant is untouched.
 */
export function rankingReproduces(first: BenchRow[], second: BenchRow[]):
  { ok: true; order: string[]; sigma: number; spread: number } | Refusal {
  const pooled = rankBySolving([...first, ...second]);
  if (!pooled.ok) return { ok: false, reason: `pooled: ${pooled.reason}` };

  const a = solveRates(first);
  const b = solveRates(second);
  if (a.length < 2 || b.length < 2) {
    return { ok: false, reason: "a pass is missing one of the harnesses, so there is nothing to compare" };
  }
  if (a[0].harness !== b[0].harness) {
    return { ok: false, reason: `the passes disagree on the leader: ${a[0].harness} then ${b[0].harness}` };
  }
  if (a[0].harness !== pooled.winner) {
    return { ok: false, reason: `the passes lead with ${a[0].harness} but the pooled result ranks ${pooled.winner}` };
  }

  /*
   * "Wild variance" made concrete: the leader's rate must not swing by more
   * than half between passes. Two passes that disagree that much are measuring
   * the corpus, not the engine.
   */
  const spread = Math.abs(a[0].rate - b[0].rate);
  if (spread > 0.5) {
    return {
      ok: false,
      reason: `the leader's solve rate swung from ${(a[0].rate * 100).toFixed(0)}% to `
        + `${(b[0].rate * 100).toFixed(0)}% between passes, which is the suite measuring noise`,
    };
  }
  return {
    ok: true,
    order: pooled.order.map((h) => h.harness),
    sigma: pooled.sigma,
    spread,
  };
}

export type SolveRate = {
  harness: string;
  runs: number;
  solved: number;
  rate: number;
  cases: string[];
};

/** Did this run pass the tests it never saw? That is the only thing that counts here. */
function solved(row: BenchRow): boolean {
  return row.scores.hidden_tests === 1;
}

export function solveRates(rows: BenchRow[]): SolveRate[] {
  const by = new Map<string, BenchRow[]>();
  for (const r of rows) {
    if (r.overall === null) continue;
    by.set(r.harness, [...(by.get(r.harness) ?? []), r]);
  }
  const out: SolveRate[] = [];
  for (const [harness, list] of by) {
    const n = list.length;
    const s = list.filter(solved).length;
    out.push({
      harness,
      runs: n,
      solved: s,
      rate: n === 0 ? 0 : s / n,
      cases: [...new Set(list.map((r) => r.suite))].sort(),
    });
  }
  return out.sort((a, b) => b.rate - a.rate);
}

/** Standard error of the difference between two independent proportions. */
function seOfDifference(a: SolveRate, b: SolveRate): number {
  const va = (a.rate * (1 - a.rate)) / Math.max(1, a.runs);
  const vb = (b.rate * (1 - b.rate)) / Math.max(1, b.runs);
  return Math.sqrt(va + vb);
}

/**
 * Runs per engine needed for the observed gap to clear two standard errors.
 *
 * Solves n from |p1 - p2| = 2 * sqrt((p1q1 + p2q2) / n). Assumes the observed
 * rates are the true ones, which they are not - so it is a scale, not a
 * promise: it answers "another handful or another hundred?"
 */
function runsNeeded(a: SolveRate, b: SolveRate): number | null {
  const diff = Math.abs(a.rate - b.rate);
  if (diff === 0) return null;
  const spread = a.rate * (1 - a.rate) + b.rate * (1 - b.rate);
  return Math.ceil((4 * spread) / (diff * diff));
}

export function rankBySolving(rows: BenchRow[]):
  | { ok: true; winner: string; order: SolveRate[]; difference: number; sigma: number }
  | (Refusal & { order: SolveRate[]; needed?: number | null }) {
  const s = solveRates(rows);
  if (s.length < 2) {
    return { ok: false, reason: "only one harness has results; nothing to rank", order: s };
  }
  const thin = s.filter((h) => h.runs < MIN_RUNS_PER_HARNESS);
  if (thin.length) {
    return {
      ok: false,
      order: s,
      reason: `not enough runs: ${thin.map((h) => `${h.harness} has ${h.runs} of ${MIN_RUNS_PER_HARNESS}`).join(", ")}`,
    };
  }
  const narrow = s.filter((h) => h.cases.length < MIN_CASES);
  if (narrow.length) {
    return {
      ok: false,
      order: s,
      reason: `not enough cases: ${narrow.map((h) => `${h.harness} ran ${h.cases.length} of ${MIN_CASES}`).join(", ")}`,
    };
  }

  const [first, second] = s;
  const difference = first.rate - second.rate;
  const se = seOfDifference(first, second);
  const sigma = se === 0 ? Infinity : difference / se;
  if (sigma < 2) {
    return {
      ok: false,
      order: s,
      needed: runsNeeded(first, second),
      reason: `${first.harness} solves ${first.solved}/${first.runs} and ${second.harness} `
        + `${second.solved}/${second.runs}, a gap of ${(difference * 100).toFixed(0)} points at only `
        + `${sigma.toFixed(2)} standard errors - inside sampling noise`,
    };
  }
  return { ok: true, winner: first.harness, order: s, difference, sigma };
}

/**
 * The route order the ranking implies, for routes the suite actually measured.
 *
 * Deliberately narrow. Only routes whose engine appears in the ranking are
 * touched, and they are redealt into the order_by values those routes ALREADY
 * occupy. Nothing unmeasured moves: shuffling a route the suite never ran would
 * be the opinion this step exists to replace, wearing a benchmark's clothes.
 *
 * A no-op result is a real answer: routing already agreed with the measurement.
 * What changes is provenance - the order is derived from recorded runs and can
 * be recomputed, rather than being a number someone typed.
 */
export function routeOrderFrom(
  order: string[],
  routes: { modelId: string; engine: string; routeOrder: number }[],
): { modelId: string; from: number; to: number }[] {
  const measured = routes
    .filter((r) => order.includes(r.engine))
    .sort((a, b) => a.routeOrder - b.routeOrder);
  const slots = measured.map((r) => r.routeOrder);

  const byRank = [...measured].sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine));
  const changes: { modelId: string; from: number; to: number }[] = [];
  byRank.forEach((r, i) => {
    if (r.routeOrder !== slots[i]) changes.push({ modelId: r.modelId, from: r.routeOrder, to: slots[i] });
  });
  return changes;
}
