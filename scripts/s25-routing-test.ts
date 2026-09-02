/**
 * S25 — the routing half: quota is an input, and the ceilings behave differently.
 *
 * The runner half (a coding task actually completing on the next engine) is in
 * `s25-routing-test.sh`, because it needs to start real runner containers and a
 * suite running inside one cannot start another.
 *
 * What is asserted here is the decision, and the decision is where the plan puts
 * its warnings: "a confident wrong quota figure is worse than an honest
 * unknown"; "a test that only proves metered calls stopped would pass on an
 * implementation that stopped everything"; "it says which engines were spent and
 * when each resets".
 */
import { createPool } from "../src/db.js";
import { CANDIDATES, NON_CHAT, routesForRole } from "../src/catalog.js";
import { checkConnectionAccess } from "../src/isolation.js";
import {
  ASSUMED_RESET_MS,
  ceilings,
  engineerLadder,
  enforceSoftCeiling,
  harnessAvailable,
  meteredRefusal,
  noteRateLimited,
  noteServed,
  readQuota,
  recordQuota,
  retryAfterFrom,
} from "../src/quota.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 260)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));
const falsy = (m: string, a: unknown) => (!a ? ok(m) : bad(m, "falsy", a));

const STAMP = Date.now().toString(36);
const ALPHA = `s25_alpha_${STAMP}`;
const BETA = `s25_beta_${STAMP}`;
const SLUG = `s25-${STAMP}`;
const CONF = `s25-conf-${STAMP}`;

let projectId = "";
let confidentialId = "";

async function setup(): Promise<void> {
  for (const [id, name] of [[ALPHA, "S25 Alpha"], [BETA, "S25 Beta"]]) {
    await pool.query(
      `INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type,
                                  confidentiality_eligibility, harness_auth_dir, health)
       VALUES ($1, 's25', $2, 'Enrique', 'Enrique', 'subscription_login',
               ARRAY['normal'], '/tmp/' || $1, 'healthy')
       ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
  }
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality)
     VALUES ($1, 'S25 routing', 'personal', 'normal') RETURNING id`,
    [SLUG],
  );
  projectId = p.rows[0].id;
  const c = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality)
     VALUES ($1, 'S25 confidential', 'professional', 'confidential') RETURNING id`,
    [CONF],
  );
  confidentialId = c.rows[0].id;

  for (const id of [ALPHA, BETA]) {
    for (const proj of [projectId, confidentialId]) {
      await pool.query(
        `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
         VALUES ($1, $2, ARRAY['senior_engineer']) ON CONFLICT DO NOTHING`,
        [id, proj],
      );
    }
  }

  // Two engines, and a hosted rung behind them whose executor does not exist.
  await pool.query(
    /*
     * Alpha carries a PRICE as well.
     *
     * Without one, `meteredRefusal` short-circuits on "this profile has no
     * priced routes" and the assertion that a subscription survives the money
     * ceiling passes for the wrong reason — it would still pass with the
     * subscription exemption deleted. Pricing the row forces the exemption to be
     * the only thing standing between it and a refusal.
     */
    `INSERT INTO model_registry (provider, model_id, role_assignments, health, approval_state,
                                 route_order, auth_profile_id, endpoint_url, harness,
                                 input_cost_per_mtok, output_cost_per_mtok)
     VALUES ('s25', $1, ARRAY['senior_engineer'], 'healthy', 'approved', 1, $2, NULL, 'claude_code', 1.0, 2.0),
            ('s25', $3, ARRAY['senior_engineer'], 'healthy', 'approved', 2, $4, NULL, 'claude_code', NULL, NULL),
            ('s25', $5, ARRAY['senior_engineer'], 'healthy', 'approved', 9, 'fireworks',
             'https://api.fireworks.ai/inference/v1/chat/completions', 'http_agent', 0.95, 4.0)`,
    [`s25-alpha-${STAMP}`, ALPHA, `s25-beta-${STAMP}`, BETA, `s25-hosted-${STAMP}`],
  );

  /*
   * A metered supervisor route of this suite's own.
   *
   * Without it the hard-ceiling assertion is decoration: dev has no Groq or
   * Fireworks key, so `routesForRole('supervisor')` is already empty and
   * "every metered route drops out" would pass against an implementation that
   * does nothing at all. This row makes the before-and-after differ.
   */
  await pool.query(
    `INSERT INTO model_registry (provider, model_id, role_assignments, health, approval_state,
                                 route_order, auth_profile_id, endpoint_url,
                                 input_cost_per_mtok, output_cost_per_mtok)
     VALUES ('s25', $1, ARRAY['supervisor'], 'healthy', 'approved', 1, 'fireworks',
             'https://api.fireworks.ai/inference/v1/chat/completions', 0.22, 0.66)`,
    [`s25-sup-${STAMP}`],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM model_registry WHERE provider = 's25' AND model_id LIKE $1`, [`%${STAMP}%`]);
  await pool.query(`DELETE FROM auth_profile_allowlists WHERE auth_profile_id IN ($1, $2)`, [ALPHA, BETA]);
  await pool.query(`DELETE FROM quota_observations WHERE auth_profile_id IN ($1, $2)`, [ALPHA, BETA]);
  await pool.query(`DELETE FROM auth_profiles WHERE id IN ($1, $2)`, [ALPHA, BETA]);
  await pool.query(`DELETE FROM projects WHERE slug IN ($1, $2)`, [SLUG, CONF]);
}

async function main(): Promise<void> {
  await setup();

  console.log("########## the ladder walks down, it does not stop ##########\n");
  {
    const first = await engineerLadder(pool, { projectId });
    truthy("there is an engine", first.ok);
    check("and it is the first by route order", ALPHA, first.ok ? first.rung.profileId : "(none)");
    check("a subscription, not a metered route", "subscription", first.ok ? first.rung.kind : "(none)");

    await noteRateLimited(pool, {
      profileId: ALPHA,
      detail: "Claude usage limit reached",
    });
    const second = await engineerLadder(pool, { projectId });
    truthy("with the first spent, there is still an engine", second.ok);
    check("and it is the next one down", BETA, second.ok ? second.rung.profileId : "(none)");

    const q = await readQuota(pool, ALPHA);
    check("the spent one is marked exhausted", "exhausted", q.status);
    truthy("with a reset time", q.resetsAt);
    check("marked as an estimate, because nothing reported it", true, q.estimated);
    check("and the provenance says inferred", "inferred", q.source);
    const window = new Date(q.resetsAt ?? 0).getTime() - Date.now();
    truthy(
      `the assumed window is the documented one (${Math.round(window / 60000)} min)`,
      Math.abs(window - ASSUMED_RESET_MS) < 60_000,
    );

    const obs = await pool.query<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM quota_observations WHERE auth_profile_id = $1 ORDER BY at DESC LIMIT 1`,
      [ALPHA],
    );
    check("the observation behind it is kept", "rate_limited", obs.rows[0]?.kind);
    truthy("with what the provider actually said", obs.rows[0]?.detail.includes("usage limit"));
  }

  console.log("\n########## and when there is nothing left, it says what and when ##########\n");
  {
    await noteRateLimited(pool, { profileId: BETA, detail: "429 too many requests" });
    const none = await engineerLadder(pool, { projectId });
    check("no engine is available", false, none.ok);
    /*
     * The reason is read out of a variable rather than asserted inside
     * `if (!none.ok)`.
     *
     * The first sabotage pass made the ladder ignore quota entirely; `none.ok`
     * came back true, the whole block was skipped, and five assertions simply
     * did not run — reported as neither pass nor fail. Assertions that vanish
     * when the code is wrong are the decoration the rules warn about.
     */
    const reason = none.ok ? "(an engine was returned)" : none.reason;
    console.log(`  park reason: ${reason}`);
    truthy("the reason names the first engine", reason.includes(ALPHA));
    truthy("and the second", reason.includes(BETA));
    truthy("and when they come back", /until \d{4}-\d{2}-\d{2}/.test(reason));
    truthy("and says the figures are estimates", reason.includes("estimated"));
    truthy(
      "and does not blame quota for the hosted rung, which has no executor",
      none.skipped.some((s) => s.includes("http_agent") && s.includes("S28")),
    );
  }

  console.log("\n########## a reset is a reset, without a sweep to notice it ##########\n");
  {
    await recordQuota(pool, {
      profileId: ALPHA,
      kind: "rate_limited",
      status: "exhausted",
      estimated: true,
      resetsAt: new Date(Date.now() - 60_000),
      detail: "expired window",
    });
    const q = await readQuota(pool, ALPHA);
    check("a window that has passed reads healthy", "healthy", q.status);
    const back = await engineerLadder(pool, { projectId });
    truthy("and the engine is back in the ladder", back.ok && back.rung.profileId === ALPHA);

    // A run that finished is the only direct evidence any of these give.
    await noteRateLimited(pool, { profileId: BETA, detail: "429" });
    await noteServed(pool, { profileId: BETA });
    check("a run that completed clears the mark", "healthy", (await readQuota(pool, BETA)).status);
  }

  console.log("\n########## isolation decides before quota does ##########\n");
  {
    await pool.query(`DELETE FROM auth_profile_allowlists WHERE project_id = $1`, [projectId]);
    const denied = await engineerLadder(pool, { projectId });
    check("a project on nobody's allowlist gets no engine", false, denied.ok);
    const deniedReason = denied.ok ? "(an engine was returned)" : denied.reason;
    truthy("and the reason is the allowlist, not a quota", deniedReason.includes("not allowlisted"));
    falsy("no quota is blamed for it", deniedReason.includes("spent"));
    // A confidential project may only use profiles eligible for it.
    const conf = await engineerLadder(pool, { projectId: confidentialId });
    check("a confidential project refuses an ineligible profile", false, conf.ok);
    const confReason = conf.ok ? "(an engine was returned)" : conf.reason;
    truthy("saying so", confReason.includes("not eligible for confidential"));

    // Restore for the ceiling tests below.
    for (const id of [ALPHA, BETA]) {
      await pool.query(
        `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
         VALUES ($1, $2, ARRAY['senior_engineer']) ON CONFLICT DO NOTHING`,
        [id, projectId],
      );
    }
  }

  console.log("\n########## reset times are read, never invented ##########\n");
  {
    const secs = retryAfterFrom("HTTP 429 retry-after: 90 seconds");
    truthy("retry-after in seconds is read", secs && Math.abs(secs.getTime() - Date.now() - 90_000) < 5_000);
    const iso = retryAfterFrom("limit reached, resets at 2026-09-03T04:00:00Z");
    check("an explicit reset timestamp is read", "2026-09-03T04:00:00.000Z", iso?.toISOString());
    check("and anything else is null, not a guess", null, retryAfterFrom("you have run out"));
    check("as is nothing at all", null, retryAfterFrom(null));
  }

  console.log("\n########## the two ceilings do different things ##########\n");
  {
    const before = await ceilings(pool);
    console.log(`  month to date: ${before.spendUsd.toFixed(4)} (hard ${before.hardUsd ?? "-"})`);

    // Soft: notify once, change nothing.
    await pool.query(
      `UPDATE model_policy SET soft_ceiling_usd = 0.0001, monthly_ceiling_usd = 1000,
              soft_notified_month = NULL`,
    );
    /*
     * Clear last run's issue.
     *
     * The dedupe key is the MONTH, deliberately — one notification per month is
     * the behaviour. So the second run of this suite in the same month bumps an
     * existing row instead of inserting one, and a "created in the last two
     * minutes" assertion would report zero. Counting by key after clearing is
     * the version that means the same thing on the first run and the fifth.
     */
    await pool.query(`DELETE FROM issues WHERE category = 'budget.soft_ceiling'`);
    await pool.query(
      `INSERT INTO model_usage (provider, model_id, role, input_tokens, output_tokens, cost_usd)
       VALUES ('s25', $1, 'supervisor', 1000, 1000, 0.05)`,
      [`s25-spend-${STAMP}`],
    );
    const routesBefore = (await routesForRole(pool, "supervisor")).length;
    truthy("there is a metered supervisor route to lose", routesBefore > 0);
    const first = await enforceSoftCeiling(pool);
    const again = await enforceSoftCeiling(pool);
    check("the soft ceiling notifies", true, first.notified);
    check("exactly once", false, again.notified);
    const issues = await pool.query<{ n: string; occurrences: number }>(
      `SELECT count(*)::text AS n, coalesce(max(occurrences), 0)::int AS occurrences
         FROM issues WHERE category = 'budget.soft_ceiling'`,
    );
    check("one issue", "1", issues.rows[0].n);
    check("raised once, not bumped a second time", 1, issues.rows[0].occurrences);
    const stillRouting = await routesForRole(pool, "supervisor");
    check("and routing is unchanged", routesBefore, stillRouting.length);
    const stillCoding = await engineerLadder(pool, { projectId });
    truthy("coding is unchanged too", stillCoding.ok);

    // Hard: metered routes drop out, subscription work carries on.
    await pool.query(`UPDATE model_policy SET monthly_ceiling_usd = 0.001`);
    const over = await ceilings(pool);
    check("month-to-date is over the hard ceiling", true, over.overHard);
    const meteredRoutes = await routesForRole(pool, "supervisor");
    check("every metered supervisor route drops out", 0, meteredRoutes.length);
    const coding = await engineerLadder(pool, { projectId });
    truthy("...and a coding task still has an engine", coding.ok);
    check("on its subscription", "subscription", coding.ok ? coding.rung.kind : "(none)");
    ok("...which is the half that matters: stopping everything would also pass the first assertion");

    const blocked = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE action = 'budget.ceiling_block' AND at > now() - interval '2 minutes'`,
    );
    truthy("and the block is audited", Number(blocked.rows[0].n) > 0);
  }

  console.log("\n########## the broker refuses a metered credential too ##########\n");
  {
    // Still over the hard ceiling from the block above.
    const metered = await checkConnectionAccess(pool, { connectionSlug: "fireworks", projectId: null });
    check("a metered profile is refused at the broker", false, metered.allowed);
    check("as a budget refusal, not an isolation breach", "budget.ceiling",
      metered.allowed ? "(allowed)" : metered.code);
    truthy("saying the number",
      !metered.allowed && /against a ceiling of/.test(metered.reason));
    check("a subscription login is not gated by a money ceiling", null, await meteredRefusal(pool, ALPHA));
    const phone = await checkConnectionAccess(pool, { connectionSlug: "telnyx", projectId: null });
    truthy("and neither is the phone, which is not a model route", phone.allowed);

    await pool.query(`UPDATE model_policy SET monthly_ceiling_usd = 25.00, soft_ceiling_usd = NULL`);
  }

  console.log("\n########## the registry says what it would actually route to ##########\n");
  {
    /*
     * "Two healthy supervisor routes" is asserted against the SEEDER, not this
     * database.
     *
     * Dev has no Groq or Fireworks key, so those rows have never been probed
     * into existence here — counting them would report 0 and mean nothing. What
     * actually determines the production chain is how many supervisor
     * candidates the seeder declares, and that is what S25 changed: it was four,
     * and two of them served 1 call between them.
     */
    const supCandidates = CANDIDATES.filter((c) => c.roles.some((r) => r === "supervisor"));
    check("the supervisor is declared with a primary and one fallback", 2, supCandidates.length);
    console.log(`  supervisor: ${supCandidates.map((c) => c.wanted[0]).join(" -> ")}`);
    truthy(
      "the primary is the open-weights route that actually serves the traffic",
      supCandidates.sort((a, b) => a.route_order - b.route_order)[0].provider === "fireworks",
    );
    falsy(
      "and no closed-weights model is in the supervisor chain",
      supCandidates.some((c) => c.open_weights !== true),
    );

    const discovered = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_registry
        WHERE approval_state = 'discovered' AND 'senior_engineer' = ANY (role_assignments)`,
    );
    truthy("an unprobed candidate exists to be excluded", Number(discovered.rows[0].n) >= 1);
    const routableIds = new Set((await routesForRole(pool, "supervisor")).map((r) => r.model_id));
    const pretenders = await pool.query<{ model_id: string }>(
      `SELECT model_id FROM model_registry
        WHERE 'supervisor' = ANY (role_assignments) AND approval_state <> 'approved'`,
    );
    falsy(
      "and no unapproved row is routable",
      pretenders.rows.some((p) => routableIds.has(p.model_id)),
    );

    // The dead chain, gone from BOTH places. A row deleted only by migration
    // comes back the next time the catalog is verified.
    const dead = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_registry
        WHERE (provider, model_id) IN (
          ('google','gemini-3.1-pro-preview'), ('nvidia','moonshotai/kimi-k3'),
          ('nvidia','deepseek-ai/deepseek-v4-pro-0813'),
          ('nvidia','nvidia/nemotron-3.5-lightning-30b-a3b'),
          ('google','gemini-3.1-flash-lite'))`,
    );
    check("the dead free-tier rows are gone from the registry", "0", dead.rows[0].n);
    falsy(
      "and from the seeder that would put them back",
      CANDIDATES.some(
        (c) =>
          (c.provider === "google" || c.provider === "nvidia")
          && c.roles.some((r) => r === "senior_engineer"),
      ),
    );
    truthy(
      "the named engineering fallback is in the seeder, not just in SQL",
      CANDIDATES.some((c) => c.wanted.some((w) => w.includes("kimi-k2p7-code"))),
    );

    /*
     * Roles that had exactly one route keep it.
     *
     * Asserted against the SEEDER rather than the dev database, and deliberately:
     * dev has no Google or NVIDIA key, so those rows have never existed here and
     * a row count would pass for the wrong reason. What decides whether the role
     * empties in production is whether a candidate still declares it — the same
     * list the deletion had to be made in.
     */
    const declares = (role: string) =>
      [...CANDIDATES, ...NON_CHAT].some((c) => c.roles.some((r) => r === role));
    for (const role of ["vision", "embeddings", "stt", "supervisor", "senior_engineer", "reviewer"]) {
      truthy(`${role} is still declared by the seeder`, declares(role));
    }

    // VI.3: the reviewer must not be from the implementer's family.
    const impl = await pool.query<{ provider: string }>(
      `SELECT provider FROM model_registry
        WHERE 'senior_engineer' = ANY (role_assignments) AND approval_state = 'approved'
          AND provider <> 's25'
        ORDER BY route_order LIMIT 1`,
    );
    const rev = await pool.query<{ provider: string; model_id: string }>(
      `SELECT provider, model_id FROM model_registry
        WHERE 'reviewer' = ANY (role_assignments) ORDER BY route_order LIMIT 1`,
    );
    console.log(`  implementer ${impl.rows[0]?.provider} / reviewer ${rev.rows[0]?.provider}`);
    truthy(
      "the first reviewer is a different family from the first implementer",
      impl.rows[0] && rev.rows[0] && impl.rows[0].provider !== rev.rows[0].provider,
    );
  }

  console.log("\n########## an executor that does not exist is not a rung ##########\n");
  {
    check("claude_code runs", true, harnessAvailable("claude_code"));
    check("an HTTP agent loop does not, and the fake does not pretend it does",
      false, harnessAvailable("http_agent"));
    check("a chat route with no executor at all is fine", true, harnessAvailable(null));
  }

  await cleanup();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch(async (err) => {
    console.error(err);
    fail += 1;
    await cleanup().catch(() => undefined);
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });
