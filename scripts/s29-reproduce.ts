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
import { rank, rankingReproduces, summarise, type BenchRow } from "../src/ranking.js";

const pool = createPool();
const CUTOFF = process.argv[2] ?? "2026-09-03T06:25:00Z";

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
  for (const h of summarise(rows)) {
    console.log(
      `  ${h.harness.padEnd(7)} n=${h.runs} mean=${h.mean.toFixed(3)} `
      + `range=${h.min.toFixed(2)}..${h.max.toFixed(2)} cases=${h.cases.length}`,
    );
  }
  const v = rank(rows);
  console.log(`  ${v.ok ? `winner ${v.winner} by ${v.margin.toFixed(3)}` : `no ranking: ${v.reason}`}`);
}

async function main(): Promise<void> {
  const q = async (op: string) => {
    const r = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown> }>(
      `SELECT harness, suite, scores FROM benchmarks
        WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')
          AND ran_at ${op} $1::timestamptz ORDER BY ran_at`,
      [CUTOFF],
    );
    return toRows(r.rows);
  };
  const first = await q("<");
  const second = await q(">=");

  console.log(`cutoff ${CUTOFF}`);
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
