/**
 * What happens when he does not act (plan S33, IV.3).
 *
 * Three classes, and the plan is emphatic that they must be three BEHAVIOURS:
 * "All three, or the policy is one behaviour with three names."
 *
 *   wait      Waiting on his choice costs nothing. An auth handoff, a proposed
 *             capability, an approval he has not got to. The park is the
 *             correct end state; these never nag, and silence is right.
 *   re-raise  Waiting while degrading costs more every day. "Silence for a week
 *             is how you discover the backups were broken on the day you needed
 *             one." These reappear in the weekly report, with their age and
 *             their count.
 *   block     Waiting is not acceptable at all - isolation and data loss. These
 *             stop other work until closed.
 *
 * The distinction is NOT importance. A proposed capability can matter more than
 * a disk at 86%, and it still waits, because nothing gets worse while it does.
 *
 * RE-RAISING GOES IN THE WEEKLY REPORT AND NOWHERE ELSE. "A second notification
 * channel for old news is how the pager becomes a feed - and S33's closed list
 * of reasons to open a conversation would have to grow, which it should not."
 * So nothing here sends a message; it produces the lines the weekly report
 * carries, and `weekly_report` is already on the closed list.
 */
import type pg from "pg";

export type Staleness = "wait" | "re-raise" | "block";

/**
 * Which class each error category belongs to.
 *
 * Written as a table rather than inferred from severity, because severity
 * answers "how bad" and this answers "does waiting make it worse", and those
 * come apart constantly - `setup.pending` is high severity and costs nothing to
 * wait on.
 */
export const STALENESS_BY_CATEGORY: Record<string, Staleness> = {
  // Waiting on him, and nothing degrades meanwhile.
  "setup.pending": "wait",
  "auth.handoff": "wait",
  "approval.pending": "wait",
  "improvement.proposal": "wait",
  "desktop.queued": "wait",
  "oauth.expired": "wait",

  // Getting worse while it waits.
  "backup.failure": "re-raise",
  "provider.cred_expired": "re-raise",
  "resource.disk": "re-raise",
  "resource.cpu": "re-raise",
  "db.error": "re-raise",
  "connection.disabled": "re-raise",
  "schedule.missed": "re-raise",

  // Not acceptable at all.
  "security.isolation": "block",
  "security.egress": "block",
  "data.loss": "block",
};

/**
 * The class for a category nobody has classified.
 *
 * `re-raise`, and the choice is deliberate. An unclassified Issue defaulting to
 * `wait` is the failure the plan describes in one sentence - the backup that has
 * been failing for a month, silent because nobody wrote a row for it - and
 * defaulting to `block` would stop the whole system over a category somebody
 * forgot to fill in. Re-raise is noisy once a week and stops nothing, which is
 * the right cost for "we do not know yet".
 */
export const DEFAULT_STALENESS: Staleness = "re-raise";

export function stalenessFor(category: string): Staleness {
  /*
   * `Object.hasOwn` rather than a bare index with `??`. For an inherited key
   * the index returns something TRUTHY - `STALENESS_BY_CATEGORY["toString"]` is
   * a function - so `??` never fires and this returned a function where the
   * signature promises a Staleness. That value goes into `issues.staleness`,
   * which has a CHECK constraint, so it turns a classification into a database
   * error at the moment an Issue is being raised about something else.
   */
  return Object.hasOwn(STALENESS_BY_CATEGORY, category)
    ? STALENESS_BY_CATEGORY[category]
    : DEFAULT_STALENESS;
}

export type StaleIssue = {
  id: string;
  category: string;
  title: string;
  staleness: Staleness;
  ageDays: number;
  occurrences: number;
  /** How many times it has recurred since he last saw it. */
  sinceLastRaise: number;
  createdAt: string;
};

async function load(pool: pg.Pool, where: string, params: unknown[] = []): Promise<StaleIssue[]> {
  const r = await pool.query<{
    id: string; category: string; title: string; staleness: string | null;
    created_at: string; occurrences: number; occurrences_at_last_raise: number;
    age_days: string;
  }>(
    `SELECT id, category, title, staleness, created_at::text, occurrences,
            occurrences_at_last_raise,
            EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS age_days
       FROM issues
      WHERE status NOT IN ('resolved', 'ignored') ${where}
      ORDER BY created_at`,
    params,
  );
  return r.rows.map((i) => ({
    id: i.id,
    category: i.category,
    title: i.title,
    // A row with no class stored still gets one, from the same table the writer
    // would have used. A NULL here must not mean "no policy".
    staleness: (i.staleness as Staleness) ?? stalenessFor(i.category),
    ageDays: Math.floor(Number(i.age_days)),
    occurrences: i.occurrences,
    sinceLastRaise: Math.max(0, i.occurrences - i.occurrences_at_last_raise),
    createdAt: i.created_at,
  }));
}

/**
 * What the weekly report says about old Issues.
 *
 * Only the `re-raise` class, and only ones old enough to be worth mentioning.
 * A `wait` Issue is absent by design and a `block` one has already stopped
 * work, so putting either here would be the second notification channel the
 * plan warns against.
 */
export async function weeklyReRaises(
  pool: pg.Pool,
  minAgeDays = 7,
): Promise<{ issue: StaleIssue; line: string }[]> {
  const all = await load(pool, "");
  return all
    .filter((i) => i.staleness === "re-raise" && i.ageDays >= minAgeDays)
    .map((i) => ({ issue: i, line: reRaiseLine(i) }));
}

/**
 * The sentence he has not already ignored.
 *
 * "An Issue that is re-raised says how long it has been open and what has
 * changed since. 'Backup has failed 9 times since the 12th' is a different
 * sentence from the one he already ignored once."
 *
 * So the age and the count are in the line itself rather than in a field beside
 * it: a repeated title is the thing that trained him to skip it.
 */
export function reRaiseLine(i: StaleIssue): string {
  const since = new Date(i.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const recurred = i.sinceLastRaise > 0
    ? `, ${i.sinceLastRaise} more time${i.sinceLastRaise === 1 ? "" : "s"} since you last saw it`
    : ", unchanged since you last saw it";
  return `${i.title} — open ${i.ageDays} days, since ${since}, ${i.occurrences} occurrence${i.occurrences === 1 ? "" : "s"}${recurred}`;
}

/** Mark that he has now seen these, so the next line says what changed since. */
export async function markReRaised(pool: pg.Pool, ids: string[], now = new Date()): Promise<void> {
  if (!ids.length) return;
  await pool.query(
    `UPDATE issues SET last_reraised_at = $2, occurrences_at_last_raise = occurrences
      WHERE id = ANY($1::uuid[])`,
    [ids, now]);
}

/**
 * The Issues that have stopped other work.
 *
 * S12 already behaves this way for a cross-project probe; naming the class is
 * what stops that being the only one.
 */
export async function blockingIssues(pool: pg.Pool): Promise<StaleIssue[]> {
  const all = await load(pool, "");
  return all.filter((i) => i.staleness === "block");
}

/**
 * Needs You, oldest first.
 *
 * "The console sorts Needs You by age, not by recency. The oldest unresolved
 * item is by definition the one being ignored, and putting it last is how it
 * stays that way."
 */
export async function needsYou(pool: pg.Pool): Promise<StaleIssue[]> {
  return load(pool, "AND owner = 'user'");
}
