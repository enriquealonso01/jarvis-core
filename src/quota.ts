import type pg from "pg";
import { checkProfileAccess } from "./isolation.js";
import { raiseIssue } from "./notify.js";

/**
 * Quota as a routable resource (plan S25).
 *
 * The plan corrects itself here, and the correction is the whole point: "The
 * plan has been treating a subscription limit as an error — park the task and
 * notify. That is wrong, and it wastes the main advantage of running on
 * flat-rate subscriptions. Remaining quota is an input to routing."
 *
 * So a task whose primary engine is spent does not stop. It moves down a ladder
 * of engines, and only parks when there is nothing left to move to — saying
 * which engines were spent and when each of them comes back.
 *
 * Two rules run through everything below:
 *
 * 1. **An estimate says it is an estimate.** Where a subscription exposes no
 *    usage API — which is all three of them — the number is inferred from an
 *    observed rate-limit response and marked `estimated`. "A confident wrong
 *    quota figure is worse than an honest unknown, because it will route around
 *    an engine that was actually available."
 * 2. **Never substitute an account behind the task's back.** If a task names an
 *    auth profile, that profile is used or the run does not happen (AGENTS.md,
 *    plan §31). The ladder only chooses when nobody has chosen already.
 */

export type QuotaStatus = "healthy" | "limited" | "exhausted" | "unknown";

export type Quota = {
  profileId: string;
  status: QuotaStatus;
  /** 0–100, or null when nothing has reported a figure. */
  remainingPct: number | null;
  /** True when this was inferred from a rate-limit response, not reported. */
  estimated: boolean;
  resetsAt: string | null;
  source: "reported" | "inferred" | "unset";
  detail: string | null;
  observedAt: string | null;
};

const UNSET: Omit<Quota, "profileId"> = {
  status: "unknown",
  remainingPct: null,
  estimated: true,
  resetsAt: null,
  source: "unset",
  detail: null,
  observedAt: null,
};

/**
 * A subscription that has been rate-limited with no reset header is assumed
 * back after this long.
 *
 * Every provider here resets on a rolling window measured in hours, and none of
 * them says so in the response. Five hours is the shortest window any of the
 * three publishes, so it is the earliest honest moment to try again — and
 * because trying again is cheap and being wrong in the other direction means
 * an idle engine, erring short is the right direction to err.
 */
export const ASSUMED_RESET_MS = 5 * 60 * 60 * 1000;

export async function readQuota(pool: pg.Pool, profileId: string): Promise<Quota> {
  const r = await pool.query<{ quota_json: Record<string, unknown> | null }>(
    "SELECT quota_json FROM auth_profiles WHERE id = $1",
    [profileId],
  );
  if (!r.rowCount) return { profileId, ...UNSET };
  const q = r.rows[0].quota_json;
  if (!q || typeof q !== "object") return { profileId, ...UNSET };

  const resetsAt = typeof q.resets_at === "string" ? q.resets_at : null;
  let status = (typeof q.status === "string" ? q.status : "unknown") as QuotaStatus;

  /*
   * The reset is applied on READ, not by a sweep.
   *
   * A background job that clears expired quota is a second place for the truth
   * to live and a window in which routing believes an engine is spent after it
   * has come back. Reading the clock at the moment of the decision cannot drift.
   */
  if (resetsAt && new Date(resetsAt).getTime() <= Date.now()) status = "healthy";

  return {
    profileId,
    status,
    remainingPct: typeof q.remaining_pct === "number" ? q.remaining_pct : null,
    estimated: q.estimated !== false,
    resetsAt,
    source: (typeof q.source === "string" ? q.source : "unset") as Quota["source"],
    detail: typeof q.detail === "string" ? q.detail : null,
    observedAt: typeof q.observed_at === "string" ? q.observed_at : null,
  };
}

/** Write the state and the observation that caused it. One call, both records. */
export async function recordQuota(
  pool: pg.Pool,
  args: {
    profileId: string;
    kind: "reported" | "rate_limited" | "exhausted" | "served" | "reset";
    status: QuotaStatus;
    remainingPct?: number | null;
    estimated: boolean;
    resetsAt?: Date | null;
    detail?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  const resets = args.resetsAt ? args.resetsAt.toISOString() : null;
  await pool.query(
    `UPDATE auth_profiles SET quota_json = $2::jsonb WHERE id = $1`,
    [
      args.profileId,
      JSON.stringify({
        status: args.status,
        remaining_pct: args.remainingPct ?? null,
        estimated: args.estimated,
        resets_at: resets,
        source: args.estimated ? "inferred" : "reported",
        detail: args.detail ?? null,
        observed_at: new Date().toISOString(),
      }),
    ],
  );
  await pool.query(
    `INSERT INTO quota_observations
       (auth_profile_id, kind, status, remaining_pct, estimated, resets_at, detail, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      args.profileId,
      args.kind,
      args.status,
      args.remainingPct ?? null,
      args.estimated,
      resets,
      args.detail ?? null,
      args.taskId ?? null,
    ],
  );
}

/**
 * A rate-limit or quota response was seen. Mark it spent, and say when it is
 * expected back.
 *
 * `resetsAt` is whatever the provider actually said. When it says nothing, the
 * fallback window is used and the row is `estimated` — which is what stops the
 * console, and later Enrique, from reading a guess as a measurement.
 */
export async function noteRateLimited(
  pool: pg.Pool,
  args: { profileId: string; resetsAt?: Date | null; detail: string; taskId?: string | null },
): Promise<void> {
  await recordQuota(pool, {
    profileId: args.profileId,
    kind: "rate_limited",
    status: "exhausted",
    remainingPct: 0,
    estimated: !args.resetsAt,
    resetsAt: args.resetsAt ?? new Date(Date.now() + ASSUMED_RESET_MS),
    detail: args.detail,
    taskId: args.taskId ?? null,
  });
}

/** It served. Whatever was believed about it, it is available. */
export async function noteServed(
  pool: pg.Pool,
  args: { profileId: string; taskId?: string | null },
): Promise<void> {
  const before = await readQuota(pool, args.profileId);
  if (before.status === "healthy" && before.source !== "unset") return;
  await recordQuota(pool, {
    profileId: args.profileId,
    kind: "served",
    status: "healthy",
    remainingPct: null,
    estimated: true,
    resetsAt: null,
    detail: "served a request",
    taskId: args.taskId ?? null,
  });
}

// ---------------------------------------------------------------------------
// The engineer ladder
// ---------------------------------------------------------------------------

export type Rung = {
  kind: "subscription" | "hosted";
  profileId: string;
  /** Set for the hosted rung: the specific model, not "the paid route". */
  modelId?: string;
  harness: string | null;
  authDir?: string | null;
  quota: Quota;
};

/**
 * Executors that exist. The rest are S28.
 *
 * A route can be registered, approved, allowlisted and have quota to spare and
 * still be unrunnable, because nothing here can launch it. That is a different
 * fact from "busy", and conflating the two produces the worst possible park
 * message: one that blames a quota for a missing feature.
 *
 * Under the fake harness every engine is runnable, because the fake speaks the
 * protocol rather than any particular vendor CLI — which is exactly what makes
 * the ladder testable before S28 exists.
 */
export const IMPLEMENTED_HARNESSES = new Set(["claude_code", "codex"]);

/**
 * Harnesses the fake can stand in for: the vendor CLIs, which all speak the
 * same stream-json shape.
 *
 * `http_agent` is deliberately NOT here. The hosted fallback is a chat model
 * that needs an agent loop around it — tools, a working directory, a stopping
 * rule — and none of that exists yet. Letting the fake stand in for it would
 * produce a green test for a rung that cannot run in production, which is the
 * exact failure the plan describes: "the day every subscription is exhausted is
 * the day someone discovers the fallback was a phrase."
 */
const FAKEABLE_HARNESSES = new Set(["claude_code", "codex", "cursor_acp"]);

export function harnessAvailable(harness: string | null): boolean {
  if (!harness) return true;
  if (IMPLEMENTED_HARNESSES.has(harness)) return true;
  const spec = process.env.JARVIS_HARNESS ?? "";
  const fake = spec === "fake" || spec.startsWith("fake:");
  return fake && FAKEABLE_HARNESSES.has(harness);
}

export type LadderResult =
  | { ok: true; rung: Rung; skipped: string[] }
  | { ok: false; reason: string; skipped: string[] };

/**
 * Which subscriptions may run this project, in preference order.
 *
 * Order is `model_registry.route_order` for the `senior_engineer` role, so the
 * ladder and the console agree about what comes first, and reordering is a row
 * change rather than an edit here.
 */
async function engineerRoutes(pool: pg.Pool): Promise<
  { provider: string; model_id: string; auth_profile_id: string; route_order: number; harness: string | null }[]
> {
  const r = await pool.query<{
    provider: string; model_id: string; auth_profile_id: string; route_order: number;
    harness: string | null;
  }>(
    `SELECT provider, model_id, auth_profile_id, route_order, harness
     FROM model_registry
     WHERE approval_state = 'approved'
       AND auth_profile_id IS NOT NULL
       AND health IN ('healthy', 'degraded')
       AND 'senior_engineer' = ANY (role_assignments)
     ORDER BY route_order, provider, model_id`,
  );
  return r.rows;
}

/**
 * Pick the engine for a coding task.
 *
 * The order of the checks matters and is not arbitrary:
 *
 *   isolation first, then quota.
 *
 * A profile this project may not use is not a fallback that happens to be busy —
 * it is not a candidate at all, and asking about its quota first would produce a
 * park reason blaming a quota for a decision isolation had already made.
 */
export async function engineerLadder(
  pool: pg.Pool,
  args: { projectId: string | null; taskId?: string | null },
): Promise<LadderResult> {
  const routes = await engineerRoutes(pool);
  const skipped: string[] = [];
  const spent: { profileId: string; resetsAt: string | null; estimated: boolean }[] = [];

  for (const route of routes) {
    if (!harnessAvailable(route.harness)) {
      skipped.push(`${route.auth_profile_id}: no ${route.harness} executor yet (S28)`);
      continue;
    }
    const decision = await checkProfileAccess(pool, {
      authProfileId: route.auth_profile_id,
      projectId: args.projectId,
      role: "senior_engineer",
    });
    if (!decision.allowed) {
      skipped.push(`${route.auth_profile_id}: ${decision.reason}`);
      continue;
    }

    const prof = await pool.query<{ auth_type: string; harness_auth_dir: string | null; health: string }>(
      "SELECT auth_type, harness_auth_dir, health FROM auth_profiles WHERE id = $1",
      [route.auth_profile_id],
    );
    const p = prof.rows[0];
    if (!p) {
      skipped.push(`${route.auth_profile_id}: no such auth profile`);
      continue;
    }
    const subscription = p.auth_type === "subscription_login";
    if (subscription && !p.harness_auth_dir) {
      skipped.push(`${route.auth_profile_id}: no completed host login`);
      continue;
    }

    const quota = await readQuota(pool, route.auth_profile_id);
    if (quota.status === "exhausted") {
      spent.push({
        profileId: route.auth_profile_id,
        resetsAt: quota.resetsAt,
        estimated: quota.estimated,
      });
      skipped.push(`${route.auth_profile_id}: quota exhausted`);
      continue;
    }

    /*
     * A metered route is subject to the hard ceiling; a subscription is not.
     * That distinction is the entire reason the hard ceiling can drop paid
     * routes without stopping work — see `meteredAllowed`.
     */
    if (!subscription && !(await meteredAllowed(pool))) {
      skipped.push(`${route.auth_profile_id}: over the monthly hard ceiling`);
      continue;
    }

    return {
      ok: true,
      skipped,
      rung: {
        kind: subscription ? "subscription" : "hosted",
        profileId: route.auth_profile_id,
        modelId: subscription ? undefined : route.model_id,
        harness: route.harness,
        authDir: p.harness_auth_dir,
        quota,
      },
    };
  }

  return { ok: false, reason: parkReason(spent, skipped), skipped };
}

/**
 * What to say when there is nothing left.
 *
 * "Only when that is also exhausted does the task park, and it says which
 * engines were spent and when each resets." A park that says "no engine
 * available" is the failure this sentence exists to prevent.
 */
export function parkReason(
  spent: { profileId: string; resetsAt: string | null; estimated: boolean }[],
  skipped: string[],
): string {
  if (!spent.length) {
    return skipped.length
      ? `no engineering route is usable here: ${skipped.join("; ")}`
      : "no engineering route is registered";
  }
  const parts = spent.map((s) => {
    if (!s.resetsAt) return `${s.profileId} (no reset time known)`;
    const when = new Date(s.resetsAt).toISOString().replace("T", " ").slice(0, 16);
    return `${s.profileId} until ${when}Z${s.estimated ? " (estimated)" : ""}`;
  });
  const others = skipped.filter((s) => !s.includes("quota exhausted"));
  const tail = others.length ? `. Also unusable: ${others.join("; ")}` : "";
  return `every engineering route is spent: ${parts.join(", ")}${tail}`;
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export type Ceilings = {
  spendUsd: number;
  softUsd: number | null;
  hardUsd: number | null;
  overSoft: boolean;
  overHard: boolean;
};

/** The soft ceiling defaults to 80% of the hard one, so one number configures both. */
export async function ceilings(pool: pg.Pool): Promise<Ceilings> {
  const r = await pool.query<{ spend: string; soft: string | null; hard: string | null }>(
    `SELECT coalesce((SELECT sum(cost_usd) FROM model_usage
                       WHERE at >= date_trunc('month', now())), 0)::text AS spend,
            p.soft_ceiling_usd::text  AS soft,
            p.monthly_ceiling_usd::text AS hard
       FROM model_policy p`,
  );
  const row = r.rows[0];
  const spendUsd = Number(row?.spend ?? 0);
  const hardUsd = row?.hard == null ? null : Number(row.hard);
  const softUsd =
    row?.soft != null ? Number(row.soft) : hardUsd == null ? null : Math.round(hardUsd * 80) / 100;
  return {
    spendUsd,
    softUsd,
    hardUsd,
    overSoft: softUsd != null && spendUsd >= softUsd,
    overHard: hardUsd != null && spendUsd >= hardUsd,
  };
}

/** Metered routes are allowed while month-to-date spend is under the hard ceiling. */
export async function meteredAllowed(pool: pg.Pool): Promise<boolean> {
  return !(await ceilings(pool)).overHard;
}

/**
 * The soft ceiling notifies once a month and changes nothing.
 *
 * "Exactly one notification" is enforced by the month stamp rather than by
 * `raiseIssue` deduplication, because a dedupe key that included the month would
 * still fire again the moment the issue was closed, and one that did not would
 * never fire again in a later month.
 */
export async function enforceSoftCeiling(pool: pg.Pool): Promise<{ notified: boolean }> {
  const c = await ceilings(pool);
  if (!c.overSoft || c.softUsd == null) return { notified: false };

  const claimed = await pool.query(
    `UPDATE model_policy
        SET soft_notified_month = date_trunc('month', now())::date
      WHERE soft_notified_month IS DISTINCT FROM date_trunc('month', now())::date
      RETURNING id`,
  );
  if (!claimed.rowCount) return { notified: false };

  await raiseIssue(pool, {
    category: "budget.soft_ceiling",
    title: `[spend] ${c.spendUsd.toFixed(2)} of ${c.hardUsd?.toFixed(2) ?? "?"} this month`,
    dedupeKey: `spend.soft.${new Date().toISOString().slice(0, 7)}`,
    service: "models",
    owner: "jarvis",
    requiredAction: "Nothing. Routing is unchanged; this is the halfway marker.",
    evidence: { spend_usd: c.spendUsd, soft_usd: c.softUsd, hard_usd: c.hardUsd },
  });
  return { notified: true };
}

/**
 * A reset time from whatever the provider said, or null.
 *
 * Deliberately narrow. Only two shapes are read — an explicit `retry-after` in
 * seconds, and an ISO timestamp next to the word `reset` — because a loose
 * parser here produces a confident wrong reset time, which is the one failure
 * mode the plan singles out: it routes around an engine that is available, or
 * back to one that is not.
 */
export function retryAfterFrom(text: string | null | undefined): Date | null {
  if (!text) return null;
  const seconds = /retry[- ]after[":\s]+(\d{1,6})/i.exec(text);
  if (seconds) return new Date(Date.now() + Number(seconds[1]) * 1000);
  const iso = /reset[^0-9]{0,20}(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?Z?)/i.exec(text);
  if (iso) {
    const when = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(when.getTime())) return when;
  }
  return null;
}

/**
 * Why a metered credential is refused, or null if it is not.
 *
 * Subscription logins are exempt by design: the hard ceiling exists to bound
 * MONEY, and a flat-rate subscription costs the same whether it is used or
 * idle. The plan is specific that a coding task must still complete on its
 * subscription route past the ceiling — "a test that only proves metered calls
 * stopped would pass on an implementation that stopped everything."
 */
export async function meteredRefusal(pool: pg.Pool, profileId: string): Promise<string | null> {
  const r = await pool.query<{ auth_type: string }>(
    "SELECT auth_type FROM auth_profiles WHERE id = $1",
    [profileId],
  );
  const authType = r.rows[0]?.auth_type;
  if (!authType || authType === "subscription_login") return null;

  /*
   * Only profiles that can actually spend are gated. `backup_b2`, `telnyx`,
   * `github_personal_admin` and the rest are api_key profiles too, and stopping
   * backups or the phone because the MODEL budget ran out would be a far worse
   * outcome than an overspend.
   */
  const metered = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_registry
      WHERE auth_profile_id = $1 AND input_cost_per_mtok IS NOT NULL`,
    [profileId],
  );
  if (Number(metered.rows[0]?.n ?? 0) === 0) return null;

  const c = await ceilings(pool);
  if (!c.overHard) return null;
  return `month-to-date model spend is ${c.spendUsd.toFixed(2)} against a ceiling of ${c.hardUsd?.toFixed(2)}`;
}
