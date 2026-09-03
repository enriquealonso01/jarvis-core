/**
 * Set the senior_engineer route order from the benchmark, or refuse.
 *
 *   node --import tsx scripts/s29-apply-route.ts          what it would do
 *   node --import tsx scripts/s29-apply-route.ts --write  do it
 *
 * S29's Done-when is that the route was CHOSEN BY MEASUREMENT. Routing already
 * happened to order claude ahead of codex, so the numbers agreeing with it
 * proves nothing on its own - a guess that turns out right is still a guess.
 * What changes here is provenance: after this the order is computed from
 * recorded runs by a rule anyone can re-run, and the audit row says which runs
 * decided it.
 *
 * Every refusal in `rank` reaches production as "change nothing". A suite that
 * cannot separate two engines must not be allowed to reorder them, because the
 * cost of acting on noise is paid by every task that routes afterwards.
 */
import { createPool } from "../src/db.js";
import { readdirSync } from "node:fs";
import { comparableRuns, rankBySolving, routeOrderFrom, type BenchRow } from "../src/ranking.js";

const pool = createPool();
const WRITE = process.argv.includes("--write");

/** Registry harness names to the engine names the benchmark records. */
const ENGINE_FOR: Record<string, string> = { claude_code: "claude", codex: "codex" };

async function main(): Promise<void> {
  const b = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown>; ran_at: Date }>(
    `SELECT harness, suite, scores, ran_at FROM benchmarks
      WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')`,
  );
  const all: BenchRow[] = b.rows.map((x) => ({
    harness: x.harness,
    suite: x.suite,
    overall: x.scores.overall === null || x.scores.overall === undefined ? null : Number(x.scores.overall),
    scores: (x.scores.scores ?? {}) as Record<string, number | null>,
    ranAt: x.ran_at,
  }));

  /*
   * Only runs that faced the corpus as it stands. This is the difference
   * between deciding and being talked into it: pooled over every era the
   * ranking certifies at 2.6 standard errors, but nearly all of that margin
   * comes from early runs made while harness defects, since fixed, were costing
   * the trailing engine points. Routing must not be reordered by a defect we
   * already repaired.
   */
  const corpus = readdirSync("benchmarks/cases", { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const rows = comparableRuns(all, corpus);
  console.log(`${rows.length} of ${all.length} runs faced the current ${corpus.length}-case corpus`);

  /*
   * Ranked by how often each engine SOLVES, not by its average score.
   *
   * The mean was the wrong summary for this data and the two methods disagree
   * on exactly the decision that matters: by mean claude leads by 0.083, which
   * clears the eyeballed 0.072 band; by solve rate the same runs are 7/12
   * against 3/10, a gap of 1.39 standard errors, which is noise. Scores are
   * bimodal, so a mean tracks the MIX of solved and unsolved runs and turns a
   * difference in how OFTEN an engine succeeds into a decimal that invites
   * comparison against a threshold. The proportion carries its own sampling
   * error, so the refusal is computed instead of judged.
   */
  const verdict = rankBySolving(rows);
  for (const h of verdict.order) {
    console.log(`  ${h.harness.padEnd(7)} solved ${h.solved}/${h.runs} = ${(h.rate * 100).toFixed(0)}%`);
  }
  if (!verdict.ok) {
    console.log(`REFUSED: ${verdict.reason}`);
    if (verdict.needed) console.log(`  ~${verdict.needed} runs per engine would settle it`);
    console.log("nothing changed - a suite that cannot separate them must not reorder them");
    return;
  }
  const order = verdict.order.map((h) => h.harness);
  console.log(`ranking: ${order.join(" > ")} (${verdict.sigma.toFixed(2)} standard errors, ${rows.length} runs)`);

  const reg = await pool.query<{ model_id: string; harness: string; route_order: number }>(
    `SELECT model_id, harness, route_order FROM model_registry
      WHERE 'senior_engineer' = ANY (role_assignments) AND approval_state = 'approved'
        AND pool = 'normal'
      ORDER BY route_order`,
  );
  const routes = reg.rows.map((r) => ({
    modelId: r.model_id,
    engine: ENGINE_FOR[r.harness] ?? r.harness,
    routeOrder: r.route_order,
  }));
  for (const r of routes) {
    console.log(`  ${r.routeOrder.toString().padStart(3)}  ${r.modelId}  (${r.engine}${order.includes(r.engine) ? "" : ", unmeasured"})`);
  }

  const changes = routeOrderFrom(order, routes);
  if (!changes.length) {
    console.log("");
    console.log("no change: the route order already matches the measurement");
  }
  for (const c of changes) console.log(`  ${c.modelId}: ${c.from} -> ${c.to}`);

  if (!WRITE) {
    console.log("");
    console.log("(dry run - pass --write to apply)");
    return;
  }

  for (const c of changes) {
    await pool.query(`UPDATE model_registry SET route_order = $2 WHERE model_id = $1`, [c.modelId, c.to]);
  }
  /*
   * The audit row is the point of the exercise as much as the ordering is: it
   * records that this order came from N runs of the suite on a given date, so
   * the next person to ask "why is claude first?" gets an answer that is not
   * "it always has been".
   */
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, metadata)
     VALUES ('jarvis', 'route_order_measured', 'senior_engineer', $1)`,
    [
      JSON.stringify({
        summary: `senior_engineer order set from the benchmark: ${order.join(" > ")}`,
        order,
        sigma: verdict.sigma,
        runs: rows.length,
        per_harness: verdict.order.map((h) => ({ harness: h.harness, runs: h.runs, solved: h.solved, rate: h.rate, cases: h.cases })),
        changes,
      }),
    ],
  );
  console.log(`applied ${changes.length} change(s) and recorded the basis`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
