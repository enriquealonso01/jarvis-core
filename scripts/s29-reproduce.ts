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
import { rankBySolving, rankingReproduces, solveRates, type BenchRow } from "../src/ranking.js";

const pool = createPool();
/*
 * A window per pass, not just a midpoint.
 *
 * "Re-run the same pair twice" means two comparable passes over the same
 * corpus. Splitting all history at a midpoint puts every earlier experiment -
 * different corpus, harness defects since fixed - into the first pass and calls
 * the result a re-run.
 */
const START = process.argv[2] ?? "2026-09-03T07:44:00Z";
const MID = process.argv[3] ?? "2026-09-03T08:16:30Z";
const END = process.argv[4] ?? "2026-09-03T08:48:30Z";

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
  const q = async (from: string, to: string) => {
    const r = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown> }>(
      `SELECT harness, suite, scores FROM benchmarks
        WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')
          AND ran_at >= $1::timestamptz AND ran_at < $2::timestamptz ORDER BY ran_at`,
      [from, to],
    );
    return toRows(r.rows);
  };
  const first = await q(START, MID);
  const second = await q(MID, END);

  console.log(`pass one ${START} to ${MID}, pass two ${MID} to ${END}`);
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
