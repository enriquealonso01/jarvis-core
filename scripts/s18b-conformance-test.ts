/**
 * S18b — the contracts, checked against the code that implements them.
 *
 * Part IV defines these and nothing verified them, which is how the taxonomy
 * gained three error classes that existed in no code for weeks. Both halves
 * read their table at run time rather than restating it, so neither goes stale
 * when a row is added: a hand-written copy of the rules inside a test is a
 * second thing to keep in sync, and the copy is always the one that rots.
 *
 * The transitions half is deliberately NOT a blocking guard in production. It
 * was measured first: of 2627 transitions this system has recorded, 2576 are
 * drawn by the document and 51 are not - including 37 cancellations of queued
 * tasks, which is obviously correct behaviour the document simply never drew.
 * Refusing those would have stranded real work to satisfy a document. So the
 * divergences are listed, each one either a known gap awaiting Enrique's ruling
 * or a failure, and anything NEW fails immediately.
 */
import { createPool } from "../src/db.js";
import { isLegalTransition, taskTransitions, taxonomyRows } from "../src/conformance.js";
import { POLICY_FOR_TESTS } from "../src/failures.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/**
 * Transitions the code makes that the document does not draw.
 *
 * Each one is real behaviour that looks right, against a document that is
 * read-only law and therefore not mine to edit. They are recorded in BLOCKED.md
 * for Enrique to rule on: either the document gains the transition, or the code
 * stops making it. Listing them here keeps the suite useful in the meantime -
 * a permanently red suite is one nobody reads, and a silent one catches
 * nothing.
 */
const KNOWN_DIVERGENCES: { from: string; to: string; why: string }[] = [
  { from: "queued", to: "cancelled", why: "cancelling a queued task; the document draws cancel only from running, paused and waiting_*" },
  { from: "running", to: "queued", why: "the recovery ladder re-queues directly; the document routes it through retry_scheduled or recovering" },
  { from: "preparing", to: "waiting_for_provider", why: "a credential failure during preparation; the document allows preparing to queued or failed_terminal only" },
  { from: "queued", to: "succeeded", why: "a task that finished without a running row; needs explaining before it is blessed" },
  { from: "queued", to: "waiting_for_user", why: "parked from the queue before a worker claimed it - a projectless heavy task, for one" },
  { from: "queued", to: "running", why: "claimed without a preparing row; the document draws queued to preparing to running" },
];

async function main(): Promise<void> {
  console.log("1. every error class the code implements has a taxonomy row");
  const rows = await taxonomyRows();
  const byClass = new Map(rows.map((r) => [r.errorClass, r]));
  rows.length >= 20
    ? ok(`the taxonomy parsed: ${rows.length} classes`)
    : bad(`only ${rows.length} classes parsed - the table shape probably changed`);

  const implemented = Object.keys(POLICY_FOR_TESTS);
  const orphans = implemented.filter((c) => !byClass.has(c));
  orphans.length === 0
    ? ok(`all ${implemented.length} implemented classes appear in the taxonomy`)
    : bad(`implemented but not in the taxonomy: ${orphans.join(", ")}`);

  console.log("");
  console.log("2. the retry policy in code matches the retry policy in the document");
  for (const cls of implemented) {
    const row = byClass.get(cls);
    if (!row) continue;
    const policy = POLICY_FOR_TESTS[cls];
    const docSaysRetry = row.retry === "yes";
    const codeRetries = policy.maxRetries > 0;
    if (docSaysRetry !== codeRetries) {
      bad(`${cls}: the taxonomy says retry=${row.retry}, the code allows ${policy.maxRetries}`);
      continue;
    }
    if (docSaysRetry && row.limit !== null && row.limit !== policy.maxRetries) {
      bad(`${cls}: the taxonomy limit is ${row.limit}, the code allows ${policy.maxRetries}`);
      continue;
    }
    ok(`${cls}: retry=${row.retry} limit=${row.limit ?? "-"} matches maxRetries=${policy.maxRetries}`);
  }

  console.log("");
  console.log("3. every transition this system has made is drawn by the document");
  const legal = await taskTransitions();
  legal.length >= 30
    ? ok(`the task machine parsed: ${legal.length} legal transitions`)
    : bad(`only ${legal.length} transitions parsed - the document shape probably changed`);

  const seen = await pool.query<{ from_state: string | null; to_state: string; n: string }>(
    `SELECT from_state, to_state, count(*)::text AS n FROM task_transitions GROUP BY 1, 2`,
  );
  const known = new Set(KNOWN_DIVERGENCES.map((d) => `${d.from}->${d.to}`));
  const unexplained: string[] = [];
  for (const x of seen.rows) {
    if (isLegalTransition(legal, x.from_state, x.to_state)) continue;
    const key = `${x.from_state}->${x.to_state}`;
    if (!known.has(key)) unexplained.push(`${key} (x${x.n})`);
  }
  unexplained.length === 0
    ? ok(`no new drift: ${KNOWN_DIVERGENCES.length} known divergences, all recorded for a ruling`)
    : bad(`transitions nobody has explained: ${unexplained.join(", ")}`);

  /*
   * Reported, not asserted, and the reason is worth writing down.
   *
   * Which shapes appear depends on the history of whichever database this runs
   * against: production has made cancellations from the queue, the dev stack has
   * made others, and neither is wrong. A failure here would mean "this list does
   * not match THIS database", which is not a contract violation - so the
   * graveyard risk is handled by printing what went unseen rather than by
   * failing a suite for running somewhere else.
   */
  const stillHappening = new Set(
    seen.rows
      .filter((x) => !isLegalTransition(legal, x.from_state, x.to_state))
      .map((x) => `${x.from_state}->${x.to_state}`),
  );
  const unseen = KNOWN_DIVERGENCES.filter((d) => !stillHappening.has(`${d.from}->${d.to}`));
  console.log(
    unseen.length === 0
      ? "  note   - every recorded divergence occurs in this database"
      : `  note   - not seen in this database (may still occur elsewhere): ${unseen.map((d) => `${d.from}->${d.to}`).join(", ")}`,
  );

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
