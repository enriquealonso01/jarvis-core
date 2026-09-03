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
import { rank, routeOrderFrom, type BenchRow } from "../src/ranking.js";

const pool = createPool();
const WRITE = process.argv.includes("--write");

/** Registry harness names to the engine names the benchmark records. */
const ENGINE_FOR: Record<string, string> = { claude_code: "claude", codex: "codex" };

async function main(): Promise<void> {
  const b = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown> }>(
    `SELECT harness, suite, scores FROM benchmarks
      WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')`,
  );
  const rows: BenchRow[] = b.rows.map((x) => ({
    harness: x.harness,
    suite: x.suite,
    overall: x.scores.overall === null || x.scores.overall === undefined ? null : Number(x.scores.overall),
    scores: (x.scores.scores ?? {}) as Record<string, number | null>,
  }));

  const verdict = rank(rows);
  if (!verdict.ok) {
    console.log(`REFUSED: ${verdict.reason}`);
    console.log("nothing changed - a suite that cannot separate them must not reorder them");
    return;
  }
  const order = verdict.order.map((h) => h.harness);
  console.log(`ranking: ${order.join(" > ")} (margin ${verdict.margin.toFixed(3)}, ${rows.length} runs)`);

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
        margin: verdict.margin,
        runs: rows.length,
        per_harness: verdict.order.map((h) => ({ harness: h.harness, runs: h.runs, mean: h.mean, cases: h.cases })),
        changes,
      }),
    ],
  );
  console.log(`applied ${changes.length} change(s) and recorded the basis`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
