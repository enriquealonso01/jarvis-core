/**
 * What the suite says when it ranks by solving rather than by average.
 *
 *   node --import tsx scripts/s29-solve-rate.ts
 *
 * The mean was hiding the shape of the data. Scores are bimodal - a run that
 * passes the withheld suite lands near 1.00, one that fails it near 0.70, and
 * nothing lands between - so an average describes the MIX rather than either
 * cluster, and moves with how often an engine solves rather than with how well
 * it does so. The proportion is the honest statistic, and it comes with
 * sampling error a mean quietly hides.
 */
import { createPool } from "../src/db.js";
import { readdirSync } from "node:fs";
import { rank, rankBySolving, comparableRuns, type BenchRow } from "../src/ranking.js";

const pool = createPool();

async function main(): Promise<void> {
  const r = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown>; ran_at: Date }>(
    `SELECT harness, suite, scores, ran_at FROM benchmarks
      WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex') ORDER BY ran_at`,
  );
  const all: BenchRow[] = r.rows.map((x) => ({
    harness: x.harness,
    suite: x.suite,
    overall: x.scores.overall === null || x.scores.overall === undefined ? null : Number(x.scores.overall),
    scores: (x.scores.scores ?? {}) as Record<string, number | null>,
    ranAt: x.ran_at,
  }));

  /*
   * Rank only the runs that faced the corpus as it stands now. Pooling every
   * run ever recorded is what made this script certify a result whose margin
   * came almost entirely from an era of fixed harness defects; see
   * `comparableRuns`. Reported rather than applied silently - a window that
   * quietly discards two thirds of the evidence has to say so.
   */
  const corpus = readdirSync("benchmarks/cases", { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const rows = comparableRuns(all, corpus);
  console.log(`${rows.length} of ${all.length} runs faced the current ${corpus.length}-case corpus`);
  console.log("");

  const byMean = rank(rows);
  console.log(`by mean score: ${byMean.ok ? `${byMean.winner} by ${byMean.margin.toFixed(3)}` : `no ranking (${byMean.reason})`}`);
  console.log("");

  const bySolving = rankBySolving(rows);
  for (const h of bySolving.order) {
    console.log(`  ${h.harness.padEnd(7)} solved ${h.solved}/${h.runs} = ${(h.rate * 100).toFixed(0)}%  over ${h.cases.length} cases`);
  }
  console.log("");
  if (bySolving.ok) {
    console.log(`by solve rate: ${bySolving.winner} wins, ${bySolving.sigma.toFixed(2)} standard errors clear`);
  } else {
    console.log(`by solve rate: NO RANKING - ${bySolving.reason}`);
    if (bySolving.needed) {
      const short = bySolving.order.map((h) => `${h.harness} ${Math.max(0, bySolving.needed! - h.runs)}`).join(", ");
      console.log(`runs per engine needed: ~${bySolving.needed} (still short by: ${short})`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
