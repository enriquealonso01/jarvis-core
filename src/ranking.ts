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
};

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
  const winner = r.order[0];
  return {
    ok: true,
    floor: winner.min,
    basis: `the lowest of ${winner.runs} runs by ${winner.harness} across ${winner.cases.length} cases`,
  };
}

/**
 * Does a second pass reproduce the first pass's ranking?
 *
 * This is S29's Done-when, and it is deliberately not "did the winner score the
 * same". Scores move; an ordering that survives a re-run is what routing can be
 * built on.
 */
export function rankingReproduces(first: BenchRow[], second: BenchRow[]):
  { ok: true; order: string[] } | Refusal {
  const a = rank(first);
  const b = rank(second);
  if (!a.ok) return { ok: false, reason: `first pass: ${a.reason}` };
  if (!b.ok) return { ok: false, reason: `second pass: ${b.reason}` };
  if (a.winner !== b.winner) {
    return { ok: false, reason: `the ranking did not hold: ${a.winner} then ${b.winner}` };
  }
  return { ok: true, order: [a.winner, ...a.order.slice(1).map((h) => h.harness)] };
}

/**
 * The route order the ranking implies, for routes the suite actually measured.
 *
 * Deliberately narrow. Only routes whose engine appears in the ranking are
 * touched, and they are given the order_by values those routes ALREADY occupy,
 * redealt by rank. Nothing unmeasured moves: cursor and the hosted open-weights
 * route have never been through the suite, and shuffling them on the strength
 * of a benchmark they never ran would be the opinion this step exists to
 * replace, wearing a benchmark's clothes.
 *
 * Reusing the existing slots rather than renumbering keeps every unmeasured
 * route exactly where it was relative to the measured ones. The suite is
 * answering "which of these two is better", not "what should the whole table
 * look like".
 *
 * A no-op result is a real and expected answer: it means routing already agreed
 * with the measurement. The difference it makes is provenance - after this the
 * order is derived from recorded runs and can be recomputed, rather than being
 * a number someone typed.
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
