/**
 * Reclaiming space without deleting what he asked Jarvis to keep (plan S34).
 *
 * The plan's own heading for this is the whole problem: "The self-repair's
 * cheapest lever is deleting his data."
 *
 *   "N7 is 'disk hits 85% at 03:00, Maintenance prunes images and old
 *    artifacts, records what it did, and does not wake him.' **Artifacts are
 *    the corpus S30 answers from** — the dumped PDFs, the forwarded threads,
 *    the call transcripts — and 'somewhere I can dump stuff and ask about it
 *    later' is one of the oldest requirements here. So the automatic remedy for
 *    a full disk, running unattended at three in the morning, is deleting the
 *    thing he will ask about next month.
 *
 *    It would not even fail visibly: S30's test dumps documents and asks three
 *    weeks later, and it passes on the day it is written. The failure arrives
 *    in production, as an honest 'I don't have that' about something he
 *    definitely gave Jarvis."
 *
 * So the design is an ALLOW-LIST of what may be reclaimed, not a deny-list of
 * what must be kept. The difference decides the failure mode: a deny-list that
 * forgets a category deletes it, and a category nobody thought of is exactly
 * what the next kind of artifact will be. Everything not named here is data.
 *
 * And when the allow-list is exhausted and the disk is still climbing, that is
 * an Issue rather than a deeper prune. The honest sentence is "I cannot free
 * more without deleting things you asked me to keep" - "and that is his
 * decision, not a 3am one."
 */
import type pg from "pg";
import { raiseIssue } from "./notify.js";
import { stalenessFor } from "./staleness.js";

/**
 * Start refusing new uploads here — ABOVE the prune threshold, deliberately.
 *
 * The comment here used to read "below the prune threshold on purpose",
 * which is the opposite of the number. The ordering is right and the
 * sentence was wrong: pruning at 0.85 removes only rebuildable or expired
 * debris, so it is cheap and runs first; refusing his uploads is the
 * harsher measure and waits until 0.90. A comment that contradicts the
 * constant beside it is worse than no comment, because the next person to
 * change a threshold will trust it.
 */
export const INGEST_REFUSE_AT = 0.90;
/** Start reclaiming here. N7's number. */
export const PRUNE_AT = 0.85;

export type DiskUsage = { totalBytes: number; freeBytes: number };

export function usedRatio(d: DiskUsage): number {
  return d.totalBytes > 0 ? (d.totalBytes - d.freeBytes) / d.totalBytes : 0;
}

/**
 * Everything Maintenance may delete unattended, and nothing else.
 *
 * Each entry is something that is either REBUILDABLE (it can be produced again
 * from what remains) or EXPIRED (a retention rule already said it should be
 * gone). Those are the only two justifications, and an entry that is neither
 * does not belong here whatever it would free.
 */
export const RECLAIMABLE = {
  docker_images: { why: "rebuildable: images and build caches can be pulled or rebuilt" },
  build_caches: { why: "rebuildable: a cache is by definition reconstructible" },
  reaped_worktrees: { why: "rebuildable: a finished task's worktree is a checkout of a commit" },
  expired_audio: { why: "expired: raw call audio past its 7/10-day retention" },
  compacted_task_events: { why: "expired: event detail past the window anything reads it in" },
  restore_drill_scratch: { why: "rebuildable: a drill's scratch directory" },
} as const;

export type ReclaimKind = keyof typeof RECLAIMABLE;

export type ReclaimCandidate = { kind: string; bytes: number; detail?: string };

export type ReclaimPlan = {
  /** What will actually be deleted. */
  approved: ReclaimCandidate[];
  /** What was offered and refused, with the reason. This is the load-bearing half. */
  refused: { candidate: ReclaimCandidate; why: string }[];
  bytesReclaimable: number;
};

/**
 * Decide what may go.
 *
 * Refusals are returned rather than silently dropped: a caller offering
 * `knowledge_chunks` should see the word "no" and the reason, because the
 * alternative is a future caller adding a category and quietly discovering that
 * nothing happened - or worse, that something did.
 */
export function planReclaim(candidates: ReclaimCandidate[]): ReclaimPlan {
  const approved: ReclaimCandidate[] = [];
  const refused: { candidate: ReclaimCandidate; why: string }[] = [];
  for (const c of candidates) {
    // Object.hasOwn, not `in`. `in` walks the prototype chain, so a candidate
    // whose kind was "constructor", "__proto__" or "toString" was APPROVED
    // FOR DELETION by the allow-list whose whole purpose is refusing to
    // delete data. Observed on the box before this fix: three such kinds
    // approved while `knowledge_chunks` was correctly refused - the real
    // logic worked, and anything inherited walked straight past it.
    if (Object.hasOwn(RECLAIMABLE, c.kind)) approved.push(c);
    else {
      refused.push({
        candidate: c,
        why: `${c.kind} is data rather than debris: it is neither rebuildable nor expired, so deleting it is his decision`,
      });
    }
  }
  return {
    approved,
    refused,
    bytesReclaimable: approved.reduce((n, c) => n + c.bytes, 0),
  };
}

export type MaintenanceResult = {
  ranAt: Date;
  usedBefore: number;
  usedAfter: number;
  deleted: ReclaimCandidate[];
  refused: { candidate: ReclaimCandidate; why: string }[];
  /** Raised when the allow-list is exhausted and the disk is still over. */
  issueRaised: boolean;
  woke: boolean;
};

/**
 * Reclaim what is safe, and file an Issue for the rest.
 *
 * `perform` does the deleting, and is injected so this module cannot delete
 * anything by itself - the policy is testable without a filesystem, and the
 * thing that actually removes bytes is somewhere a reviewer will look for it.
 */
export async function runMaintenance(
  pool: pg.Pool,
  args: {
    disk: DiskUsage;
    candidates: ReclaimCandidate[];
    perform: (c: ReclaimCandidate) => Promise<number>;
    now?: Date;
  },
): Promise<MaintenanceResult> {
  const now = args.now ?? new Date();
  const usedBefore = usedRatio(args.disk);
  const plan = planReclaim(args.candidates);

  let freed = 0;
  const deleted: ReclaimCandidate[] = [];
  if (usedBefore >= PRUNE_AT) {
    for (const c of plan.approved) {
      freed += await args.perform(c);
      deleted.push(c);
    }
  }

  const after: DiskUsage = { ...args.disk, freeBytes: args.disk.freeBytes + freed };
  const usedAfter = usedRatio(after);

  /*
   * Still over, with nothing left on the allow-list. The plan is explicit that
   * the next step is NOT a deeper prune, and the class is the one from IV.2
   * that degrades while it waits - so it re-raises weekly rather than being
   * asked once and forgotten, and rather than waking him at 03:00.
   */
  let issueRaised = false;
  if (usedAfter >= PRUNE_AT) {
    const r = await raiseIssue(pool, {
      category: "resource.disk",
      title: "[disk] I cannot free more without deleting things you asked me to keep",
      dedupeKey: "resource.disk",
      owner: "user",
      severityOverride: "high",
      evidence: {
        used_before: Number(usedBefore.toFixed(4)),
        used_after: Number(usedAfter.toFixed(4)),
        freed_bytes: freed,
        refused: plan.refused.map((x) => x.candidate.kind),
      },
      requiredAction:
        "Everything rebuildable or expired has already gone. What is left is artifacts inside their "
        + "retention and the knowledge corpus - the documents you dumped and the threads you forwarded. "
        + "Deleting any of it is your call, not a 3am one.",
    });
    issueRaised = r.issueId !== null;
  }

  return {
    ranAt: now,
    usedBefore,
    usedAfter,
    deleted,
    refused: plan.refused,
    issueRaised,
    /*
     * N7: "records what it did, and does not wake him." A disk filling is the
     * re-raise class, which by S33's rules reaches him through the weekly
     * report - never as a message Jarvis starts at three in the morning.
     */
    woke: false,
  };
}

/** The staleness class a full disk gets, read from the one table that decides it. */
export function diskStaleness(): string {
  return stalenessFor("resource.disk");
}

export type IngestVerdict =
  | { accept: true }
  | { accept: false; reason: string };

/**
 * May a new upload be accepted?
 *
 * "Ingest degrades before it deletes. Above the threshold, new uploads are
 * refused with a truthful reason rather than accepted and quietly pruned later.
 * Refusing an upload is recoverable; accepting one and deleting it is not - and
 * accepting-then-deleting looks like success at the moment it happens, which is
 * why it is the one to rule out."
 *
 * `bytes` is included because the question is whether THIS write fits: "check
 * free space before writing, not after. A partially written artifact that
 * filled the disk is worse than a refused one, and it is the shape that takes
 * the box down rather than merely disappointing him."
 */
export function mayAcceptUpload(disk: DiskUsage, bytes: number): IngestVerdict {
  /*
   * A disk we cannot measure is not an empty disk.
   *
   * `usedRatio` answers 0 for a non-positive total, which is the right
   * answer for the prune side - it means maintenance does not start
   * deleting on a garbage reading. Here it read as "0% used" and accepted
   * anything, so a failed statfs would have taken an upload of any size.
   * This module's own rule is that refusing is recoverable and accepting
   * is not, so both sides now fail in the safe direction.
   */
  if (!(disk.totalBytes > 0)) {
    return {
      accept: false,
      reason: "I cannot read how much room is left, and I will not accept "
        + "something I might not be able to keep. Try again shortly.",
    };
  }
  const after: DiskUsage = { ...disk, freeBytes: disk.freeBytes - bytes };
  if (usedRatio(after) >= INGEST_REFUSE_AT) {
    const pct = Math.round(usedRatio(disk) * 100);
    return {
      accept: false,
      reason: `the disk is ${pct}% full, and this upload would not leave enough room. `
        + "Nothing you have already given me has been deleted to make space - "
        + "I would rather refuse this than quietly prune something you asked me to keep.",
    };
  }
  return { accept: true };
}
