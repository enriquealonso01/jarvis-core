/**
 * S29 — the ranking refuses before it invents.
 *
 * Every assertion here is about NOT producing a number. The plan's warning is
 * that a floor picked before the suite can separate a good model from a fluent
 * one is an opinion with a decimal point, so the interesting behaviour is the
 * refusals: too few runs, too few cases, and a gap inside the suite's own
 * measured noise.
 */
import { comparableRuns, MIN_RUNS_PER_HARNESS, proposeFloor, rank, rankBySolving, rankingReproduces, routeOrderFrom, solveRates, summarise, TIE_BAND, type BenchRow } from "../src/ranking.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** n runs for one harness, `solved` of them passing the withheld suite. */
const solvedRuns = (h: string, solved: number, total: number): BenchRow[] =>
Array.from({ length: total }, (_, i) => ({
harness: h,
suite: CASES[i % CASES.length],
overall: i < solved ? 1 : 0.7,
scores: { hidden_tests: i < solved ? 1 : 0 },
}));

const CASES = ["case-a", "case-b", "case-c"];

/** n runs for one harness, cycling the cases, each scoring `overall`. */
function runs(harness: string, overalls: number[], cases = CASES): BenchRow[] {
  return overalls.map((o, i) => ({
    harness,
    suite: cases[i % cases.length],
    overall: o,
    scores: { correctness: 1, hidden_tests: o > 0.8 ? 1 : 0, quota_consumed: 120000 },
  }));
}

function main(): void {
  console.log("1. a summary describes the runs it was given");
  const s = summarise([...runs("claude", [0.7, 0.8, 0.75, 0.75]), ...runs("codex", [0.6, 0.6, 0.6, 0.6])]);
  s.length === 2 && s[0].harness === "claude"
    ? ok("harnesses are ordered by mean")
    : bad(`ordering was ${s.map((x) => x.harness).join(",")}`);
  Math.abs(s[0].spread - 0.1) < 1e-9
    ? ok("spread is the observed range, not a guess")
    : bad(`spread was ${s[0].spread}`);
  s[0].perDimension.quota_consumed === undefined
    ? ok("quota is not averaged into the per-dimension summary")
    : bad("quota_consumed leaked into the summary as a quality dimension");

  console.log("");
  console.log("2. it refuses to rank on thin evidence");
  const thin = rank([...runs("claude", [0.9, 0.9]), ...runs("codex", [0.5, 0.5])]);
  !thin.ok && thin.reason.includes("not enough runs")
    ? ok(`two runs each is refused (${thin.ok ? "" : thin.reason.slice(0, 48)})`)
    : bad("a ranking was produced from two runs per harness");

  const oneCase = rank([
    ...runs("claude", [0.9, 0.9, 0.9, 0.9], ["only-case"]),
    ...runs("codex", [0.5, 0.5, 0.5, 0.5], ["only-case"]),
  ]);
  !oneCase.ok && oneCase.reason.includes("not enough cases")
    ? ok("and so is a ranking drawn from a single case")
    : bad("one case was enough to rank two harnesses");

  console.log("");
  console.log("3. a gap inside the noise band is a tie, not a win");
  const close = rank([
    ...runs("claude", [0.70, 0.71, 0.70, 0.71]),
    ...runs("codex", [0.68, 0.69, 0.68, 0.69]),
  ]);
  !close.ok && close.reason.includes("too close to call")
    ? ok(`a 0.02 gap is declared a tie, under the ${TIE_BAND} band`)
    : bad("a difference smaller than the suite's own variance was called a win");

  const clear = rank([
    ...runs("claude", [0.90, 0.92, 0.91, 0.93]),
    ...runs("codex", [0.60, 0.61, 0.62, 0.60]),
  ]);
  clear.ok && clear.winner === "claude"
    ? ok("while a gap well outside it is called")
    : bad(`a clear win was not reported: ${clear.ok ? "" : clear.reason}`);

  console.log("");
  console.log("4. the floor is derived from runs, never chosen");
  const floor = proposeFloor([
    ...runs("claude", [0.90, 0.92, 0.88, 0.93]),
    ...runs("codex", [0.60, 0.61, 0.62, 0.60]),
  ]);
  floor.ok && Math.abs(floor.floor - 0.88) < 1e-9
    ? ok("it is the winner's worst observed run, 0.88")
    : bad(`the floor was ${floor.ok ? floor.floor : floor.reason}`);
  floor.ok && floor.basis.includes("4 runs")
    ? ok("and it says what it was derived from")
    : bad("the floor did not carry its basis");

  const noFloor = proposeFloor([
    ...runs("claude", [0.70, 0.71, 0.70, 0.71]),
    ...runs("codex", [0.69, 0.70, 0.69, 0.70]),
  ]);
  !noFloor.ok && noFloor.reason.startsWith("no floor")
    ? ok("a tie yields no floor at all, rather than the first-sorted contestant's")
    : bad("a floor was set during a tie");

  const neverSolved = proposeFloor([
    ...runs("claude", [0.75, 0.74, 0.73, 0.74]),
    ...runs("codex", [0.60, 0.61, 0.62, 0.60]),
  ]);
  !neverSolved.ok && neverSolved.reason.includes("withheld suite")
    ? ok("a winner that never passed the withheld suite yields no floor")
    : bad(`a floor was derived from runs that solved nothing: ${JSON.stringify(neverSolved)}`);

  console.log("");
  console.log("5. the Done-when is a result that survives a re-run");
  /*
   * A pass is one sweep of the corpus, so five cases means five runs per engine
   * - never enough on its own to clear two standard errors. The check therefore
   * asks the plan's question: is there a ranking on everything, and do the
   * passes agree, without wild variance.
   */
  const passA = [...solvedRuns("claude", 12, 20), ...solvedRuns("codex", 5, 20)];
  const passB = [...solvedRuns("claude", 13, 20), ...solvedRuns("codex", 4, 20)];
  const rep = rankingReproduces(passA, passB);
  rep.ok && rep.order[0] === "claude"
    ? ok(`two agreeing passes reproduce, ${rep.ok ? rep.sigma.toFixed(1) : ""} sigma pooled`)
    : bad(`reproduction failed: ${rep.ok ? "" : rep.reason}`);

  /*
   * Chosen so the POOLED result is still significant while the passes disagree
   * on the leader - otherwise the refusal comes from the pooled gate and this
   * would assert nothing about pass agreement.
   */
  const lopsided = [...solvedRuns("claude", 19, 20), ...solvedRuns("codex", 3, 20)];
  const flipped = [...solvedRuns("claude", 9, 20), ...solvedRuns("codex", 11, 20)];
  const notRep = rankingReproduces(lopsided, flipped);
  !notRep.ok && notRep.reason.includes("disagree on the leader")
    ? ok("passes that disagree on the leader do not reproduce")
    : bad(`a reversed second pass was accepted: ${JSON.stringify(notRep)}`);

  // The part that must never be relaxed: no ranking at all, no reproduction.
  const tooClose = rankingReproduces(
    [...solvedRuns("claude", 10, 20), ...solvedRuns("codex", 9, 20)],
    [...solvedRuns("claude", 11, 20), ...solvedRuns("codex", 9, 20)],
  );
  !tooClose.ok && tooClose.reason.startsWith("pooled")
    ? ok("and two agreeing passes that are pooled-insignificant still do not")
    : bad("a result nobody can call was reported as reproduced");

  const wild = rankingReproduces(
    [...solvedRuns("claude", 20, 20), ...solvedRuns("codex", 2, 20)],
    [...solvedRuns("claude", 6, 20), ...solvedRuns("codex", 2, 20)],
  );
  !wild.ok && wild.reason.includes("measuring noise")
    ? ok("a leader whose rate swings wildly between passes is refused")
    : bad(`wild variance was accepted: ${JSON.stringify(wild)}`);

  console.log("");
  console.log("6. the route order follows the ranking, and touches nothing else");
  const ROUTES = [
    { modelId: "claude-sonnet-host", engine: "claude", routeOrder: 5 },
    { modelId: "codex-host", engine: "codex", routeOrder: 15 },
    { modelId: "cursor-acp-host", engine: "cursor_acp", routeOrder: 20 },
  ];
  const agrees = routeOrderFrom(["claude", "codex"], ROUTES);
  agrees.length === 0
    ? ok("an order that already matches the ranking is left alone")
    : bad(`it rewrote ${agrees.length} route(s) that were already right`);

  const flip = routeOrderFrom(["codex", "claude"], ROUTES);
  flip.length === 2 && flip.find((c) => c.modelId === "codex-host")?.to === 5
    && flip.find((c) => c.modelId === "claude-sonnet-host")?.to === 15
    ? ok("a reversed ranking swaps the two measured routes into each other's slots")
    : bad(`the swap was ${JSON.stringify(flip)}`);
  !flip.some((c) => c.modelId === "cursor-acp-host")
    ? ok("and the unmeasured route is never moved")
    : bad("a route the suite never ran was reordered");

  const unmeasuredOnly = routeOrderFrom(["claude"], ROUTES);
  unmeasuredOnly.length === 0
    ? ok("one measured engine implies no reordering at all")
    : bad("a single-engine ranking moved routes");

  console.log("");
  console.log("7. solving is a proportion, and a proportion carries sampling error");
  /*
   * Scores here are bimodal - solved runs cluster near 1.00, unsolved near
   * 0.70 - so a mean describes the MIX rather than either cluster. What
   * actually differs between engines is how often they land in the solving
   * one, and that is a proportion from a dozen runs, which is noisier than a
   * mean makes it look.
   */

  const rates = solveRates([...solvedRuns("claude", 7, 12), ...solvedRuns("codex", 3, 10)]);
  rates[0].solved === 7 && Math.abs(rates[0].rate - 7 / 12) < 1e-9
    ? ok("the rate is solved over runs, counted from the withheld suite")
    : bad(`rate was ${JSON.stringify(rates[0])}`);

  const real = rankBySolving([...solvedRuns("claude", 7, 12), ...solvedRuns("codex", 3, 10)]);
  !real.ok && real.reason.includes("sampling noise")
    ? ok(`tonight's own numbers are refused: ${real.ok ? "" : real.reason.slice(-46)}`)
    : bad("a 28-point gap on 12 and 10 runs was called a win");
  !real.ok && typeof real.needed === "number" && real.needed > 20
    ? ok(`and it says how many runs would settle it: ${real.ok ? "" : real.needed}`)
    : bad("no usable estimate of the runs needed");

  const decisive = rankBySolving([...solvedRuns("claude", 28, 30), ...solvedRuns("codex", 6, 30)]);
  decisive.ok && decisive.winner === "claude" && decisive.sigma > 2
    ? ok(`a gap well outside sampling error is called, at ${decisive.ok ? decisive.sigma.toFixed(1) : ""} sigma`)
    : bad(`a decisive difference was not called: ${decisive.ok ? "" : decisive.reason}`);

  const tied = rankBySolving([...solvedRuns("claude", 15, 30), ...solvedRuns("codex", 15, 30)]);
  !tied.ok
    ? ok("and identical rates over thirty runs each are still not a ranking")
    : bad("two identical engines were ordered");


  console.log("");
  console.log("########## only the runs that faced the current corpus ##########");
  console.log("");

  /*
   * The scenario is the real one, from 2026-09-03. An early era where the
   * leader looks dominant - because harness defects since fixed were costing
   * the other engine points - followed by a later era on the full corpus where
   * the two are much closer. Pooled, the suite certifies. It should not.
   */
  const at = (iso: string) => new Date(iso);
  const era = (h: string, solved: number, total: number, suite: string, iso: string): BenchRow[] =>
    Array.from({ length: total }, (_, i) => ({
      harness: h, suite,
      overall: i < solved ? 1 : 0.7,
      scores: { hidden_tests: i < solved ? 1 : 0 },
      ranAt: at(iso),
    }));

  const CORPUS = ["case-a", "case-b", "case-new"];
  const early = [
    ...era("claude", 6, 11, "case-a", "2026-09-03T05:00:00Z"),
    ...era("codex", 2, 12, "case-a", "2026-09-03T05:00:00Z"),
    ...era("claude", 0, 1, "case-b", "2026-09-03T05:00:00Z"),
    ...era("codex", 0, 1, "case-b", "2026-09-03T05:00:00Z"),
  ];
  const late = [
    ...era("claude", 21, 34, "case-new", "2026-09-03T09:00:00Z"),
    ...era("codex", 13, 33, "case-new", "2026-09-03T09:00:00Z"),
  ];

  const pooled = rankBySolving([...early, ...late]);
  pooled.ok && pooled.sigma > 2
    ? ok(`pooling every era certifies, at ${pooled.sigma.toFixed(2)} sigma - which is the bug`)
    : bad(`the pooled scenario does not reproduce the over-certification: ${pooled.ok ? pooled.sigma : pooled.reason}`);

  const windowed = comparableRuns([...early, ...late], CORPUS);
  windowed.length === late.length
    ? ok(`the window keeps only the ${late.length} runs made once every case existed`)
    : bad(`window kept ${windowed.length} runs, expected ${late.length}`);

  const honest = rankBySolving(windowed);
  !honest.ok || honest.sigma < 2
    ? ok("and on those alone the suite declines to certify")
    : bad(`the windowed ranking still certified at ${honest.ok ? honest.sigma.toFixed(2) : ""} sigma`);

  /*
   * A case that has left the corpus takes its runs with it: comparing engines
   * on a case only one of them ever faced is the same contamination in another
   * shape.
   */
  const withRetired = comparableRuns(
    [...late, ...era("claude", 5, 5, "case-retired", "2026-09-03T10:00:00Z")], CORPUS);
  withRetired.every((r) => CORPUS.includes(r.suite))
    ? ok("runs of a case no longer in the corpus are dropped")
    : bad("a retired case survived the window");

  /*
   * And when a current case has never been run, there is no window in which the
   * corpus was whole - so the honest answer is nothing, not everything.
   */
  comparableRuns(late, [...CORPUS, "case-never-run"]).length === 0
    ? ok("a case with no runs yet means nothing is comparable, rather than everything")
    : bad("an unrun case did not empty the window");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  console.log(`(minimum ${MIN_RUNS_PER_HARNESS} runs per harness, ${CASES.length} cases)`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
