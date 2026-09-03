/**
 * S29 — the ranking refuses before it invents.
 *
 * Every assertion here is about NOT producing a number. The plan's warning is
 * that a floor picked before the suite can separate a good model from a fluent
 * one is an opinion with a decimal point, so the interesting behaviour is the
 * refusals: too few runs, too few cases, and a gap inside the suite's own
 * measured noise.
 */
import { MIN_RUNS_PER_HARNESS, proposeFloor, rank, rankBySolving, rankingReproduces, routeOrderFrom, solveRates, summarise, TIE_BAND, type BenchRow } from "../src/ranking.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

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
  console.log("5. the Done-when is an ordering that survives a re-run");
  const passA = [...runs("claude", [0.90, 0.92, 0.91, 0.93]), ...runs("codex", [0.60, 0.61, 0.62, 0.60])];
  const passB = [...runs("claude", [0.88, 0.95, 0.89, 0.94]), ...runs("codex", [0.65, 0.58, 0.63, 0.61])];
  const rep = rankingReproduces(passA, passB);
  rep.ok && rep.order[0] === "claude"
    ? ok("the same winner on both passes reproduces, though the scores moved")
    : bad(`reproduction failed: ${rep.ok ? "" : rep.reason}`);

  const flipped = [...runs("claude", [0.60, 0.61, 0.62, 0.60]), ...runs("codex", [0.90, 0.92, 0.91, 0.93])];
  const notRep = rankingReproduces(passA, flipped);
  !notRep.ok && notRep.reason.includes("did not hold")
    ? ok("a flipped second pass is reported as not reproducing")
    : bad("a reversed ranking was accepted as reproduced");

  const thinSecond = rankingReproduces(passA, [...runs("claude", [0.9, 0.9]), ...runs("codex", [0.5, 0.5])]);
  !thinSecond.ok && thinSecond.reason.startsWith("second pass")
    ? ok("and a thin second pass says which pass was thin")
    : bad("a thin second pass was not attributed");

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
  const solvedRuns = (h: string, solved: number, total: number): BenchRow[] =>
    Array.from({ length: total }, (_, i) => ({
      harness: h,
      suite: CASES[i % CASES.length],
      overall: i < solved ? 1 : 0.7,
      scores: { hidden_tests: i < solved ? 1 : 0 },
    }));

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
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  console.log(`(minimum ${MIN_RUNS_PER_HARNESS} runs per harness, ${CASES.length} cases)`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
