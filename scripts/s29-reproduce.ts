/**
 * Did a second pass reproduce the first pass's ranking?
 *
 *   node --import tsx scripts/s29-reproduce.ts <iso-cutoff>
 *
 * S29's Done-when, and the plan is precise about what it asks: *"Re-run the
 * same pair twice: scores should be close. Wild variance means the suite is
 * measuring noise and needs more cases before anyone trusts it."*
 *
 * The check is on the ORDER, not the numbers. Scores move between runs - the
 * same engine on the same case has scored 0.74 and 0.67 - so demanding they
 * repeat would be demanding the suite lie. What routing needs is that the
 * question "which of these is better" gets the same answer twice.
 *
 * Both passes go through the same refusals as any other ranking, so a pass too
 * thin or too close to call reports that rather than contributing half an
 * answer. A refusal here is not a failure of the engines; it is the suite
 * saying it cannot yet tell them apart, which is the only honest thing to say
 * when two means differ by less than one engine's own wobble.
 */
import { createPool } from "../src/db.js";
import { readdirSync } from "node:fs";
import { comparableRuns, rankBySolving, rankingReproduces, solveRates, type BenchRow } from "../src/ranking.js";

const pool = createPool();
/*
 * A window per pass, not just a midpoint.
 *
 * "Re-run the same pair twice" means two comparable passes over the same
 * corpus. Splitting all history at a midpoint puts every earlier experiment -
 * different corpus, harness defects since fixed - into the first pass and calls
 * the result a re-run.
 */
/*
 * The window defaulted to three timestamps hardcoded when this script was
 * written, so it went on reporting the same ten runs from 07:44 while three
 * campaigns ran past it - a reproduction check frozen at the moment of its
 * authorship, answering for evidence that had since quadrupled. It now splits
 * the COMPARABLE window, the runs that faced the corpus as it stands, into two
 * halves at the median run. Explicit timestamps still override, for looking at
 * a particular pass on purpose.
 */
const START = process.argv[2] ?? null;
const MID = process.argv[3] ?? null;
const END = process.argv[4] ?? null;

function toRows(rs: { harness: string; suite: string; scores: Record<string, unknown> }[]): BenchRow[] {
  return rs.map((x) => ({
    harness: x.harness,
    suite: x.suite,
    overall: x.scores.overall === null || x.scores.overall === undefined ? null : Number(x.scores.overall),
    scores: (x.scores.scores ?? {}) as Record<string, number | null>,
  }));
}

function show(label: string, rows: BenchRow[]): void {
  console.log(`${label}: ${rows.length} runs`);
  for (const h of solveRates(rows)) {
    console.log(
      `  ${h.harness.padEnd(7)} solved ${h.solved}/${h.runs} = ${(h.rate * 100).toFixed(0)}%`
      + `  over ${h.cases.length} cases`,
    );
  }
  const v = rankBySolving(rows);
  console.log(`  ${v.ok ? `winner ${v.winner}, ${v.sigma.toFixed(2)} standard errors clear` : `no ranking: ${v.reason}`}`);
}

async function main(): Promise<void> {
  const q = async (from: string | null, to: string | null) => {
    const r = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown>; ran_at: Date }>(
      `SELECT harness, suite, scores, ran_at FROM benchmarks
        WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')
          AND ($1::timestamptz IS NULL OR ran_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR ran_at <  $2::timestamptz) ORDER BY ran_at`,
      [from, to],
    );
    return toRows(r.rows).map((row, i) => ({ ...row, ranAt: r.rows[i].ran_at }));
  };

  let first: BenchRow[];
  let second: BenchRow[];
  let window: string;

  if (START && MID && END) {
    first = await q(START, MID);
    second = await q(MID, END);
    window = `pass one ${START} to ${MID}, pass two ${MID} to ${END}`;
  } else {
    /*
     * Split the comparable window at its median run, so both halves hold the
     * same number of runs whatever the campaign schedule was. Splitting by TIME
     * would put a dense campaign in one half and a quiet hour in the other, and
     * a reproduction check whose halves differ in size mostly measures that.
     */
    const corpus = readdirSync("benchmarks/cases", { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    const rows = comparableRuns(await q(null, null), corpus);
    const half = Math.floor(rows.length / 2);
    first = rows.slice(0, half);
    second = rows.slice(half);
    const at = (r: BenchRow[]) => (r.length && r[0].ranAt ? r[0].ranAt.toISOString().slice(11, 16) : "?");
    window = `${rows.length} runs on the current ${corpus.length}-case corpus,`
      + ` split at the median: ${at(first)} and ${at(second)}`;
  }

  console.log(window);
  console.log("");
  show("first pass ", first);
  console.log("");
  show("second pass", second);
  console.log("");

  const rep = rankingReproduces(first, second);
  console.log(rep.ok
    ? `REPRODUCED: ${rep.order.join(" > ")} on both passes`
    : `NOT REPRODUCED: ${rep.reason}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
