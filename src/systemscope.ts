/**
 * System work is not a project (plan S45, which revises ADR 012).
 *
 * ADR 012 seeded `jarvis-improvement` and `jarvis-maintenance` as PROJECTS, and
 * the requirements are explicit that this is wrong:
 *
 *   "*The term Project should be reserved for actual personal or professional
 *    projects the user is working on.*"
 *
 *   "Maintenance, health, security sweeps, self-improvement and internal repair
 *    are **the system operating itself**. They are not a body of work in
 *    Enrique's portfolio, and putting them there means his Projects view and his
 *    project counts are permanently contaminated by Jarvis's housekeeping."
 *
 * THIS IS A TAXONOMY CHANGE, NOT A PERMISSIONS CHANGE. The plan says so in bold,
 * and it is the thing most likely to go wrong in the doing: it would be very easy
 * to "tidy up" the boundary while relabelling, and II.5's isolation rules carry
 * over completely unchanged. A system-scoped task could not read a project's
 * secrets before and cannot now, for exactly the same reason and through exactly
 * the same code.
 *
 * FILTER BY SCOPE, NEVER BY NAME. The Debug note names the failure and its cause
 * together: "if system work reappears in project views, something is filtering by
 * name rather than by scope. **Name-based filters break the first time something
 * is renamed.**" So nothing here matches on `jarvis-` or on a slug, and the suite
 * renames a system project to prove it.
 *
 * ONE FACT, TWO COLUMNS - and that is a pre-existing hazard rather than something
 * this file introduces. `projects.is_system` and `projects.project_type = 'system'`
 * both say the same thing today. The taxonomy is `project_type`, so that is what
 * everything here reads, and the suite asserts the two agree so that the day they
 * drift is the day a test fails rather than the day his Projects view refills.
 */
import type pg from "pg";

/** The taxonomy. `system` is not one of the two a person's work can be. */
export const PORTFOLIO_TYPES = ["personal", "professional"] as const;
export const SYSTEM_TYPE = "system";

/**
 * SQL fragment selecting the scope, by type.
 *
 * Exported as a fragment rather than each caller writing its own, because "his
 * Projects view excludes system work" is not one query - it is the list, the
 * counts, the pickers and everything added later - and a rule spelled out in
 * eight places is a rule that will be right in seven.
 */
export const PORTFOLIO_ONLY = `p.project_type <> '${SYSTEM_TYPE}'`;
export const SYSTEM_ONLY = `p.project_type = '${SYSTEM_TYPE}'`;

export type Scope = "portfolio" | "system" | "all";

/**
 * What a request asked to see.
 *
 * The default is `portfolio`, and that is the whole point of the step: his view
 * is his projects unless he says otherwise. An unrecognised value falls back to
 * the default rather than to `all` — a typo should not repopulate the view with
 * housekeeping.
 */
export function scopeFrom(value: unknown): Scope {
  return value === "system" || value === "all" ? value : "portfolio";
}

export function whereForScope(scope: Scope): string {
  if (scope === "system") return SYSTEM_ONLY;
  if (scope === "all") return "TRUE";
  return PORTFOLIO_ONLY;
}

/** His project count, as he would count it. */
export async function portfolioCount(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM projects p WHERE p.archived_at IS NULL AND ${PORTFOLIO_ONLY}`,
  );
  return Number(r.rows[0].n);
}

/**
 * The two markers must agree.
 *
 * Not a rule this file invents — both columns already exist and already agree.
 * It is checked because they are two records of one fact, and the failure when
 * they drift is silent: one query filters on the type, another on the boolean,
 * and system work reappears in exactly half the places.
 */
export async function markersDisagree(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ slug: string }>(
    `SELECT slug FROM projects
      WHERE (project_type = $1) <> is_system`,
    [SYSTEM_TYPE],
  );
  return r.rows.map((x) => x.slug);
}

/* ------------------------------------------------------------------ *
 * "He can still ask."
 * ------------------------------------------------------------------ */

export type SystemActivity = {
  /** What ran, in words. */
  what: string;
  at: Date;
  outcome: string;
  project: string;
};

/**
 * "What has maintenance been doing?"
 *
 * "**He can still ask.** *What maintenance ran?*, *what changed?*, *what got
 * fixed?*, *how is the system doing?* are answerable in conversation, **which is
 * how he will actually ask — not by finding a page.**"
 *
 * So this returns SPECIFICS rather than a count. "Maintenance ran 14 times this
 * week" is the answer that makes him go and look, which is the outcome the step
 * is trying to avoid.
 */
export async function systemActivity(
  pool: pg.Pool,
  args: { since: Date; limit?: number },
): Promise<SystemActivity[]> {
  const r = await pool.query<{ title: string; at: Date; state: string; slug: string }>(
    `SELECT t.title, t.updated_at AS at, t.state, p.slug
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE ${SYSTEM_ONLY}
        AND t.updated_at >= $1
      ORDER BY t.updated_at DESC
      LIMIT $2`,
    [args.since, Math.min(50, args.limit ?? 20)],
  );
  return r.rows.map((row) => ({
    what: row.title,
    at: row.at,
    outcome: row.state,
    project: row.slug,
  }));
}

/**
 * The sentence he gets back.
 *
 * Names what actually happened. An empty week says so plainly rather than
 * producing a reassuring summary of nothing, because "nothing ran" is a real
 * answer and sometimes the important one.
 */
export function describeSystemActivity(activity: SystemActivity[], since: Date): string {
  if (!activity.length) {
    return `Nothing has run since ${since.toISOString().slice(0, 10)}. That may itself be worth a look.`;
  }
  const done = activity.filter((a) => a.outcome === "done" || a.outcome === "succeeded");
  const failed = activity.filter((a) => a.outcome.startsWith("failed"));
  const named = activity.slice(0, 3).map((a) => a.what);
  const parts = [
    `${activity.length} things since ${since.toISOString().slice(0, 10)}: ${named.join(", ")}`
    + (activity.length > named.length ? `, and ${activity.length - named.length} more` : ""),
  ];
  if (failed.length) parts.push(`${failed.length} of them failed.`);
  else if (done.length === activity.length) parts.push("All finished.");
  return `${parts.join(". ").replace(/\.\.$/, ".")}`;
}
