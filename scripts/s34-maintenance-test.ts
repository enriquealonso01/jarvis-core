/**
 * S34 — the document is still there afterwards.
 *
 * The plan's test, and it is the one that matters in this step:
 *
 *   "Then dump a document, force the disk to 85%, run Maintenance, and ask
 *    about the document — **it is still there**."
 *
 * That is written as an end-to-end because the failure it guards is invisible
 * any other way: "It would not even fail visibly. S30's test dumps documents
 * and asks three weeks later, and it passes on the day it is written. The
 * failure arrives in production, as an honest 'I don't have that' about
 * something he definitely gave Jarvis."
 *
 * So this suite really does dump a document through S30's ingest, really runs
 * Maintenance at 85%, and really asks the question afterwards. A unit test
 * asserting "artifacts are not in the reclaim list" would pass over a system
 * whose prune path never consulted the list.
 */
import { createPool } from "../src/db.js";
import { ingestDocument, retrieve } from "../src/knowledge.js";
import {
  diskStaleness, INGEST_REFUSE_AT, mayAcceptUpload, planReclaim, PRUNE_AT,
  runMaintenance, usedRatio, type ReclaimCandidate,
} from "../src/maintenance.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s34-${Math.random().toString(36).slice(2, 7)}`;
const GB = 1024 ** 3;
/** 86% full: over the prune threshold, under the ingest one. */
const FULL: { totalBytes: number; freeBytes: number } = { totalBytes: 100 * GB, freeBytes: 14 * GB };
const QUESTION = "escalation contact for the Lisbon warehouse";

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  try {
    console.log("1. he dumps a document, weeks before any of this");
    const art = (await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, mime, quarantine_state)
       VALUES ($1,$2,'text/markdown','clean') RETURNING id`,
      [pid, `${pid}/warehouse-notes.md`])).rows[0].id;
    await ingestDocument(pool, {
      projectId: pid, artifactId: art, kind: "prose",
      text: "# Warehouse\nThe escalation contact for the Lisbon warehouse is Inês Cardoso.",
    });
    const before = await retrieve(pool, { q: QUESTION, projectId: pid });
    (before.tiers.find((t) => t.tier === "knowledge")?.hits ?? []).some((h) => h.body.includes("Inês"))
      ? ok("and it answers")
      : bad("the document does not answer before maintenance runs");

    console.log("");
    console.log("2. the disk hits 85% at 03:00, and Maintenance runs");
    usedRatio(FULL) >= PRUNE_AT
      ? ok(`the fixture disk is ${Math.round(usedRatio(FULL) * 100)}% full, over the ${PRUNE_AT * 100}% threshold`)
      : bad("the fixture is not actually over the threshold");
    /*
     * The candidate list deliberately includes the things a 3am prune would
     * reach for if nothing stopped it - his artifacts and the corpus itself -
     * because a suite offering only safe candidates proves nothing about the
     * gate.
     */
    const offered: ReclaimCandidate[] = [
      { kind: "docker_images", bytes: 2 * GB },
      { kind: "expired_audio", bytes: 1 * GB },
      { kind: "reaped_worktrees", bytes: 1 * GB },
      { kind: "artifacts", bytes: 20 * GB, detail: "his uploaded documents" },
      { kind: "knowledge_chunks", bytes: 8 * GB, detail: "the corpus S30 answers from" },
      { kind: "memory_items", bytes: 1 * GB, detail: "things he told Jarvis" },
    ];
    const deletedKinds: string[] = [];
    /*
     * `perform` REALLY DELETES. My first version only recorded the kind, which
     * made the end-to-end assertion below unfailable: the deny-list sabotage
     * approved `knowledge_chunks`, and the document survived anyway because
     * nothing had actually removed it. A test whose destructive step is a
     * no-op cannot tell a working gate from a missing one - it was passing on
     * the approval list, not on the corpus.
     */
    const result = await runMaintenance(pool, {
      disk: FULL, candidates: offered,
      perform: async (c) => {
        deletedKinds.push(c.kind);
        if (c.kind === "knowledge_chunks") {
          await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
        }
        if (c.kind === "artifacts") {
          await pool.query(`DELETE FROM knowledge_chunks WHERE source_artifact_id = $1`, [art]);
          await pool.query(`DELETE FROM artifacts WHERE id = $1`, [art]);
        }
        return c.bytes;
      },
    });
    deletedKinds.join(",") === "docker_images,expired_audio,reaped_worktrees"
      ? ok(`it reclaimed only what is rebuildable or expired: ${deletedKinds.join(", ")}`)
      : bad(`it deleted ${deletedKinds.join(", ")}`);
    !deletedKinds.includes("artifacts") && !deletedKinds.includes("knowledge_chunks")
      ? ok("and touched neither his artifacts nor the corpus")
      : bad("MAINTENANCE DELETED HIS DATA");
    result.refused.length === 3
      ? ok(`refusing three offered categories, each with a reason: "${result.refused[0].why}"`)
      : bad(`${result.refused.length} refusals recorded`);

    console.log("");
    console.log("3. and the document is still there");
    /*
     * The plan's actual test. Asked through the real retrieval path, after the
     * real maintenance run, on the real corpus.
     */
    const after = await retrieve(pool, { q: QUESTION, projectId: pid });
    (after.tiers.find((t) => t.tier === "knowledge")?.hits ?? []).some((h) => h.body.includes("Inês"))
      ? ok("asked again after Maintenance, it still answers")
      : bad("THE DOCUMENT IS GONE — this is the failure that arrives in production");

    console.log("");
    console.log("4. nothing woke him");
    result.woke === false
      ? ok("N7: it recorded what it did and did not wake him")
      : bad("maintenance woke him at 03:00");
    diskStaleness() === "re-raise"
      ? ok("a filling disk is the re-raise class, so it reaches him through the weekly report")
      : bad(`a filling disk is classed ${diskStaleness()}`);

    console.log("");
    console.log("5. out of reclaimable space, still climbing → an Issue, not a deeper prune");
    await pool.query(`DELETE FROM issues WHERE dedupe_key = 'resource.disk'`);
    const nothingLeft = await runMaintenance(pool, {
      disk: FULL,
      candidates: [{ kind: "artifacts", bytes: 20 * GB }],
      perform: async () => { throw new Error("nothing reclaimable should be performed"); },
    });
    nothingLeft.deleted.length === 0
      ? ok("with only his data left, it deletes nothing")
      : bad(`it deleted ${nothingLeft.deleted.map((d) => d.kind).join(", ")}`);
    nothingLeft.issueRaised ? ok("and raises an Issue instead") : bad("no Issue was raised");
    const issue = (await pool.query<{ title: string; required_action: string }>(
      `SELECT title, required_action FROM issues WHERE dedupe_key = 'resource.disk'
        AND status NOT IN ('resolved','ignored')`)).rows[0];
    issue?.title.includes("without deleting things you asked me to keep")
      ? ok(`saying so plainly: "${issue.title}"`)
      : bad(`the Issue reads: ${issue?.title}`);
    issue?.required_action.includes("your call")
      ? ok("and that the decision is his, not a 3am one")
      : bad("the Issue does not hand the decision back");

    console.log("");
    console.log("6. ingest degrades before it deletes");
    const nearlyFull = { totalBytes: 100 * GB, freeBytes: 9 * GB };
    const refused = mayAcceptUpload(nearlyFull, 2 * GB);
    !refused.accept && refused.reason.includes("rather refuse")
      ? ok(`an upload above the threshold is refused: "${refused.reason.slice(0, 70)}..."`)
      : bad(`the upload was accepted at ${Math.round(usedRatio(nearlyFull) * 100)}% full`);
    /*
     * "Check free space before writing, not after." The verdict is about THIS
     * write, so a file large enough to cross the line on its own is refused
     * even when the disk is comfortable beforehand.
     */
    const roomy = { totalBytes: 100 * GB, freeBytes: 30 * GB };
    mayAcceptUpload(roomy, 1 * GB).accept
      ? ok("while a small upload onto a roomy disk is accepted")
      : bad("a small upload was refused on a disk with room");
    !mayAcceptUpload(roomy, 25 * GB).accept
      ? ok("and a single upload big enough to cross the line is refused before it is written, not after")
      : bad("a huge upload was accepted onto a disk it would fill");
    INGEST_REFUSE_AT > PRUNE_AT
      ? ok(`refusal (${INGEST_REFUSE_AT}) sits above pruning (${PRUNE_AT}), so reclaiming is tried first`)
      : bad("uploads are refused before anything is reclaimed");

    console.log("");
    console.log("7. the allow-list is what makes this safe");
    const plan = planReclaim([{ kind: "some_new_cache_nobody_listed", bytes: 5 * GB }]);
    plan.approved.length === 0 && plan.refused.length === 1
      ? ok("a category nobody listed is refused, because everything unlisted is data")
      : bad("an unlisted category was approved for deletion");
    /*
     * The names every JavaScript object already has. `"constructor" in
     * RECLAIMABLE` is TRUE, so an allow-list written with `in` approves
     * `constructor`, `toString` and `__proto__` for unattended deletion - an
     * allow-list that lets three things through is not one. This failed open
     * until it was found by re-running the Tester's sweep over the files that
     * landed after it.
     */
    const inherited = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"];
    const throughTheProto = planReclaim(inherited.map((k) => ({ kind: k, bytes: 1 })));
    throughTheProto.approved.length === 0
      ? ok(`and so are the names every object already has: ${inherited.join(", ")}`)
      : bad(`the prototype chain approved ${throughTheProto.approved.map((c) => c.kind).join(", ")} for deletion`);
  } finally {
    await pool.query(`DELETE FROM issues WHERE dedupe_key = 'resource.disk'`);
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
