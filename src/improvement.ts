/**
 * The weekly Improvement scan (plan S34).
 *
 * Three rules, and each one is a way this feature turns bad:
 *
 *  - **Nothing activates itself.** A scan that can enact its own suggestions is
 *    not a scan. The failure is quiet: a week later, a change Jarvis proposed
 *    and made is indistinguishable from one it was asked to make. So there is
 *    no path in this module that starts work without an explicit approval, and
 *    `approve` is the only function that creates anything.
 *
 *  - **A declined candidate does not come back.** "Decline a candidate, then
 *    run the scan again → it does not come back. Change its version and run
 *    again → it returns, and the message names what changed rather than
 *    repeating the pitch." The decline is pinned to a FINGERPRINT of the
 *    proposal, the same shape S31 uses for a tool's classification and for the
 *    same reason - the thing being gated is the thing that would otherwise get
 *    to say it had changed. Nothing has to remember to un-decline: the
 *    comparison stops matching on its own.
 *
 *  - **The asks are capped.** "A week with twenty findings produces the capped
 *    number of asks and the rest in the console." Twenty suggestions is a feed,
 *    and S33's whole point is that the pager stops being read when it becomes
 *    one.
 */
import crypto from "node:crypto";
import type pg from "pg";

/** How many findings may become a question in one week. The rest are console. */
export const ASK_CAP = 3;

export type Candidate = {
  key: string;
  title: string;
  pitch: string;
  /** What it would actually do. Hashed, so a changed plan is a changed candidate. */
  proposal: Record<string, unknown>;
};

/**
 * The identity of a proposal.
 *
 * Over what it would DO, not over how it is described: a scan that rewords its
 * pitch has not changed its mind, and bringing a declined suggestion back
 * because the adjectives moved is nagging with extra steps.
 */
export function fingerprint(c: Candidate): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify({ key: c.key, proposal: canonical(c.proposal) }))
    .digest("hex");
}

export type ScanResult = {
  /** Everything currently open, newest first. All of it is on the console. */
  open: StoredCandidate[];
  /** The capped subset worth interrupting him for. */
  asks: StoredCandidate[];
  /** Suppressed because he declined this exact proposal. */
  stillDeclined: string[];
  /** Declined once, but the proposal has changed since. */
  returned: { key: string; why: string }[];
};

export type StoredCandidate = {
  id: string;
  key: string;
  title: string;
  pitch: string;
  status: string;
  timesSeen: number;
  /** Set when this had been declined and came back changed. */
  changedSinceDecline: boolean;
};

/**
 * Record what a scan found. Creates nothing else, by construction.
 *
 * Note what this function cannot do: it has no way to start a task, change a
 * setting, or send a message. A scan that could would be the failure the step
 * names, and keeping it out of the signature is cheaper than a rule about it.
 */
export async function recordScan(
  pool: pg.Pool,
  found: Candidate[],
  now = new Date(),
): Promise<ScanResult> {
  const stillDeclined: string[] = [];
  const returned: { key: string; why: string }[] = [];

  for (const c of found) {
    const fp = fingerprint(c);
    const existing = (await pool.query<{
      id: string; status: string; declined_fingerprint: string | null; fingerprint: string;
    }>(
      `SELECT id, status, declined_fingerprint, fingerprint
         FROM improvement_candidates WHERE candidate_key = $1`, [c.key])).rows[0];

    if (!existing) {
      await pool.query(
        `INSERT INTO improvement_candidates (candidate_key, title, pitch, fingerprint, last_seen_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [c.key, c.title, c.pitch, fp, now]);
      continue;
    }

    if (existing.status === "declined") {
      if (existing.declined_fingerprint === fp) {
        /*
         * The same suggestion he already said no to. Not re-offered, and not
         * even counted as seen - a "times seen" that climbs while he is being
         * ignored is a metric that would eventually be used to justify asking
         * again.
         */
        stillDeclined.push(c.key);
        continue;
      }
      // Changed since he declined it, so it is a different proposal now.
      await pool.query(
        `UPDATE improvement_candidates
            SET status = 'proposed', title = $2, pitch = $3, fingerprint = $4,
                last_seen_at = $5, times_seen = times_seen + 1
          WHERE id = $1`,
        [existing.id, c.title, c.pitch, fp, now]);
      returned.push({
        key: c.key,
        why: "you declined this before, and what it would do has changed since",
      });
      continue;
    }

    await pool.query(
      `UPDATE improvement_candidates
          SET title = $2, pitch = $3, fingerprint = $4, last_seen_at = $5,
              times_seen = times_seen + 1
        WHERE id = $1`,
      [existing.id, c.title, c.pitch, fp, now]);
  }

  const open = (await pool.query<{
    id: string; candidate_key: string; title: string; pitch: string;
    status: string; times_seen: number;
  }>(
    `SELECT id, candidate_key, title, pitch, status, times_seen
       FROM improvement_candidates WHERE status = 'proposed'
      ORDER BY last_seen_at DESC, first_seen_at`)).rows;

  const changed = new Set(returned.map((r) => r.key));
  const all: StoredCandidate[] = open.map((r) => ({
    id: r.id, key: r.candidate_key, title: r.title, pitch: r.pitch,
    status: r.status, timesSeen: r.times_seen,
    changedSinceDecline: changed.has(r.candidate_key),
  }));

  return { open: all, asks: all.slice(0, ASK_CAP), stillDeclined, returned };
}

/**
 * What to say about one candidate.
 *
 * A returned candidate says what CHANGED rather than repeating the pitch he
 * already turned down - the same rule as S33's re-raised Issue, and for the
 * same reason: the sentence he ignored once is not a sentence worth sending
 * twice.
 */
export function askLine(c: StoredCandidate, why?: string): string {
  return c.changedSinceDecline && why ? `${c.title} — ${why}` : `${c.title} — ${c.pitch}`;
}

export async function decline(pool: pg.Pool, key: string, now = new Date()): Promise<boolean> {
  const r = await pool.query(
    `UPDATE improvement_candidates
        SET status = 'declined', declined_at = $2, declined_fingerprint = fingerprint
      WHERE candidate_key = $1 AND status = 'proposed'`,
    [key, now]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Approve one, and produce the work.
 *
 * "One-tap approval that produces no work is a button, not a decision." So this
 * returns the task id, and returns null only when there was nothing to approve
 * - a caller cannot mistake "approved" for "something is happening".
 */
export async function approve(
  pool: pg.Pool,
  key: string,
  projectId: string,
  now = new Date(),
): Promise<string | null> {
  const c = (await pool.query<{ id: string; title: string; pitch: string }>(
    `SELECT id, title, pitch FROM improvement_candidates
      WHERE candidate_key = $1 AND status = 'proposed'`, [key])).rows[0];
  if (!c) return null;

  const task = (await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, title, objective, state, priority, lane)
     VALUES ($1,$2,$3,'queued','normal','heavy') RETURNING id`,
    [projectId, c.title, c.pitch])).rows[0];

  await pool.query(
    `UPDATE improvement_candidates
        SET status = 'approved', approved_task_id = $2, approved_at = $3 WHERE id = $1`,
    [c.id, task.id, now]);
  return task.id;
}
