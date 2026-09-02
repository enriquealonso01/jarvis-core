/**
 * Tier 1 answers in about a second.
 *
 * The requirement is "no tools, reasoning off, one short reply, sub-second".
 * This runs the REAL triage against the REAL providers, because the thing under
 * test is latency and a fake model would answer instantly and prove nothing.
 *
 * Budget is 2000ms per turn, the number Enrique named. The measured utility
 * route sits near 500ms, so this has room for a slow day without being so loose
 * that a regression to the supervisor route (about 1300ms, peaking near 1800ms)
 * would slip through unnoticed - that regression is exactly what it is here to
 * catch, and it is the state this code was in when the test was written.
 */
import { createPool } from "../src/db.js";
import { triage } from "../src/callagent.js";

const BUDGET_MS = 2000;
const TURNS = [
  "hello Jarvis",
  "thank you, that is all",
  "how are you this evening",
  "good morning",
];

let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function main() {
  const pool = createPool();

  /*
   * Refuse to run without a real model.
   *
   * The first version of this suite went green in a dev database with no
   * credentials: `quickCompletion` returned null, triage fell back to its safe
   * delegation, and four turns "answered" in an average of 8ms. A latency test
   * that passes fastest when the model is missing is worse than no test, so the
   * absence of a route is a failure here, never a pass.
   */
  const route = await pool.query<{ model_id: string; provider: string }>(
    `SELECT m.model_id, m.provider
       FROM model_registry m
       JOIN auth_profiles p ON p.id = m.auth_profile_id
      WHERE 'utility' = ANY (m.role_assignments)
        AND m.approval_state = 'approved' AND m.health IN ('healthy','degraded')
        AND p.credential_id IS NOT NULL
      ORDER BY m.route_order LIMIT 1`,
  );
  if (!route.rows[0]) {
    console.log("  FAIL - no approved utility model with a credential; this suite needs a real one");
    console.log("Tier 1 latency FAIL (1)");
    process.exit(1);
  }
  console.log(`   using ${route.rows[0].provider} ${route.rows[0].model_id}`);

  console.log(`1. every tool-less turn answers inside ${BUDGET_MS}ms`);
  const times: number[] = [];
  for (const text of TURNS) {
    const started = Date.now();
    const verdict = await triage(pool, text);
    const ms = Date.now() - started;
    times.push(ms);
    if (ms <= BUDGET_MS) ok(`${ms}ms  ${verdict.mode}: ${verdict.say.slice(0, 44)}`);
    else bad(`${ms}ms  over budget  ${verdict.mode}: ${verdict.say.slice(0, 40)}`);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`     avg ${avg}ms, max ${Math.max(...times)}ms`);

  console.log("2. tier 1 is served by the small model, as a fact rather than a stopwatch");
  /*
   * This replaced an assertion on the average, which was theatre.
   *
   * The original check was "the average must be under half the budget", meant to
   * catch a regression back to the supervisor route. Deliberately putting tier 1
   * back on that route produced 712ms and PASSED, while an earlier sample of the
   * same route produced 1401ms with a 2348ms outlier and failed. The provider is
   * simply variable, so any threshold either misses the regression or fires
   * without one. Which model answered does not vary.
   */
  let served: { provider: string; model: string } | null = null;
  await triage(pool, "good evening", { onRoute: (r) => { served = r; } });
  const usedRoute = served as { provider: string; model: string } | null;
  if (!usedRoute) {
    bad("no route reported - tier 1 did not reach a model at all");
  } else {
    const eligible = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM model_registry
        WHERE model_id = $1 AND 'utility' = ANY (role_assignments)`,
      [usedRoute.model],
    );
    Number(eligible.rows[0]?.n ?? 0) > 0
      ? ok(`served by ${usedRoute.provider} ${usedRoute.model}, a utility model`)
      : bad(`served by ${usedRoute.provider} ${usedRoute.model}, which is NOT a utility model`);
  }

  console.log("3. a greeting is answered, not delegated");
  // If tier 1 delegates a greeting, the caller waits for the desk and the whole
  // sub-second path is moot however fast the model is.
  const greeting = await triage(pool, "hello Jarvis");
  greeting.mode === "answer"
    ? ok(`answered directly: ${greeting.say.slice(0, 50)}`)
    : bad(`a greeting was delegated: ${greeting.say.slice(0, 50)}`);

  await pool.end();
  console.log(fails === 0 ? "\nTier 1 latency PASS" : `\nTier 1 latency FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
