/**
 * What the suite currently says, and what it refuses to say.
 *
 *   node --import tsx scripts/s29-rank.ts            report
 *   node --import tsx scripts/s29-rank.ts --invalidate    mark defective runs
 *
 * Reads recorded runs and asks `rank`/`proposeFloor` for a verdict. Most of the
 * time the answer is a refusal with a reason, which is the intended output: a
 * ranking is only allowed once there are enough runs, enough cases, and a gap
 * wider than the suite's own measured wobble.
 *
 * Runs scored against a case that could not be passed are excluded rather than
 * deleted. slug-trailing-dash shipped a CommonJS seed under `"type": "module"`,
 * so its hidden suite never ran and every run of it scored hidden_tests 0 no
 * matter what the agent wrote. Those numbers are not evidence about an engine.
 * Deleting them would hide that the suite once measured nothing; marking them
 * keeps the mistake legible next to the corrected result.
 */
import { createPool } from "../src/db.js";
import { proposeFloor, rank, summarise, type BenchRow } from "../src/ranking.js";

const pool = createPool();

/*
 * One rule, applied to every engine alike: a run measured under a harness
 * defect that provably moved its score is not evidence about an engine.
 *
 * Applied by hand-picking rows it would be indistinguishable from choosing a
 * winner, so each class below names the defect, the fix, and why the score is
 * unusable - and two of the three classes cost claude runs too.
 */
const INVALID: { reason: string; where: string; args: unknown[] }[] = [
  {
    reason: "scored against a hidden suite that could not load, so hidden_tests was 0 whatever the agent wrote",
    where: "suite = 'slug-trailing-dash' AND ran_at < $1::timestamptz",
    args: ["2026-09-03 06:10:00+00"],
  },
  {
    reason: "the runtime argument did not survive shell quoting, so no engine ran",
    where: "harness NOT IN ('claude', 'codex')",
    args: [],
  },
  {
    reason: "parked on the push instruction the agent had no credential for, which cost it pr_quality directly",
    where: "ran_at < $1::timestamptz AND scores->'scores'->>'pr_quality' = '0'",
    args: ["2026-09-03 05:00:00+00"],
  },
];

async function invalidateDefectiveRuns(): Promise<void> {
  for (const c of INVALID) {
    const r = await pool.query(
      `UPDATE benchmarks SET scores = scores || jsonb_build_object('invalid', $${c.args.length + 1}::text)
        WHERE ${c.where} AND scores->>'invalid' IS NULL RETURNING id`,
      [...c.args, c.reason],
    );
    console.log(`  ${r.rowCount} run(s): ${c.reason.slice(0, 72)}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--invalidate")) await invalidateDefectiveRuns();

  const r = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown> }>(
    `SELECT harness, suite, scores FROM benchmarks
      WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')
      ORDER BY ran_at`,
  );
  const rows: BenchRow[] = r.rows.map((x) => ({
    harness: x.harness,
    suite: x.suite,
    overall: x.scores.overall === null || x.scores.overall === undefined ? null : Number(x.scores.overall),
    scores: (x.scores.scores ?? {}) as Record<string, number | null>,
  }));
  console.log(`${rows.length} valid runs`);
  console.log("");

  for (const h of summarise(rows)) {
    console.log(
      `${h.harness.padEnd(7)} n=${h.runs}  mean=${h.mean.toFixed(3)}  `
      + `range=${h.min.toFixed(2)}..${h.max.toFixed(2)}  spread=${h.spread.toFixed(3)}  `
      + `cases=${h.cases.length}`,
    );
    const dims = Object.entries(h.perDimension)
      .filter(([k]) => ["hidden_tests", "correctness", "scope_control", "test_quality", "pr_quality"].includes(k))
      .map(([k, v]) => `${k}=${v.toFixed(2)}`);
    console.log(`        ${dims.join("  ")}`);
  }

  console.log("");
  const verdict = rank(rows);
  console.log(verdict.ok
    ? `RANKING: ${verdict.winner} wins by ${verdict.margin.toFixed(3)}`
    : `NO RANKING: ${verdict.reason}`);

  const floor = proposeFloor(rows);
  console.log(floor.ok ? `FLOOR: ${floor.floor.toFixed(2)} - ${floor.basis}` : `NO FLOOR: ${floor.reason}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
