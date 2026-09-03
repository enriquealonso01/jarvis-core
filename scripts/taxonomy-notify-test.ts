/**
 * B10 — the three failure classes that were quietly inheriting somebody else's
 * notification policy.
 *
 * `agent.repeat`, `dependency.unavailable` and `resource.cpu` each had a retry
 * and parking policy in failures.ts and no entry in notify.ts, so `classify()`
 * handed all three the `worker.crash` fallback: high severity, ui_only, silent.
 * Enrique's assignments (BLOCKERS B10, 2026-09-03):
 *
 *   agent.repeat           -> severity error,   notify Issue + WhatsApp
 *   dependency.unavailable -> severity warning, notify Issue + ui_only
 *   resource.cpu           -> severity warning, notify ui_only (Issue if sustained)
 *
 * The interesting one is the parenthesis. "Issue if sustained" is not a notify
 * level - it says the notification and the Issue are separate decisions, and
 * one class wants different answers to them.
 *
 * The first assertion here is not about any of the three. It is that the set of
 * classes with a retry policy and the set with a notify position are the SAME
 * SET, so the next class added to one file without the other fails this suite
 * instead of silently inheriting worker.crash for however long nobody looks.
 * Asserting only the three assignments would have left the hole that produced
 * them wide open.
 */
import { createPool } from "../src/db.js";
import { POLICY_FOR_TESTS as POLICY } from "../src/failures.js";
import {
  classify, ERROR_CLASSES, raiseIssue, SUSTAINED_WINDOW_MS,
} from "../src/notify.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const KEY = `b10-${Math.random().toString(36).slice(2, 7)}`;
const T0 = new Date("2026-09-05T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const outboxFor = async (prefix: string) => (await pool.query<{ channel: string; idempotency_key: string }>(
  `SELECT channel, idempotency_key FROM notifications_outbox
    WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`, [`%${prefix}%`])).rows;

const issuesFor = async (dedupe: string) => (await pool.query<{ id: string; severity: string }>(
  `SELECT id, severity FROM issues WHERE dedupe_key = $1`, [dedupe])).rows;

async function main(): Promise<void> {
  try {
    console.log("1. every class with a retry policy has a notify position");
    /*
     * The structural assertion, and the reason this suite exists at all. A class
     * in POLICY but not in ERROR_CLASSES does not fail anywhere - it silently
     * takes worker.crash's position, which is how all three of these ended up
     * with a severity nobody chose.
     */
    const missing = Object.keys(POLICY).filter((c) => !Object.hasOwn(ERROR_CLASSES, c));
    missing.length === 0
      ? ok(`all ${Object.keys(POLICY).length} classes with a retry policy have one`)
      : bad(`inheriting worker.crash silently: ${missing.join(", ")}`);

    /*
     * And the two files must not disagree about retrying. `retryable: false` and
     * `maxRetries: 0` are the same statement made twice; a class that is
     * non-retryable in one file and retried four times in the other will be
     * retried, and the taxonomy will describe a system that does not exist.
     */
    const disagree = Object.keys(POLICY)
      .filter((c) => Object.hasOwn(ERROR_CLASSES, c))
      .filter((c) => {
        const e = ERROR_CLASSES[c];
        const p = POLICY[c];
        return e.retryable ? e.limit !== p.maxRetries : p.maxRetries !== 0;
      });
    disagree.length === 0
      ? ok("and none of them disagrees with failures.ts about how often to retry")
      : bad(`retry policy differs between the two files: ${disagree.join(", ")}`);

    console.log("");
    console.log("2. the three assignments, as decided");
    const repeat = classify("agent.repeat");
    repeat.severity === "high" && repeat.notify === "whatsapp_degraded"
      ? ok("agent.repeat: error severity, and it reaches his phone")
      : bad(`agent.repeat is ${repeat.severity}/${repeat.notify}`);
    const dep = classify("dependency.unavailable");
    dep.severity === "medium" && dep.notify === "ui_only"
      ? ok("dependency.unavailable: warning, Issue and console only")
      : bad(`dependency.unavailable is ${dep.severity}/${dep.notify}`);
    const cpu = classify("resource.cpu");
    cpu.severity === "medium" && cpu.notify === "ui_only" && (cpu.issueAfter ?? 1) > 1
      ? ok(`resource.cpu: warning, console only, Issue after ${cpu.issueAfter}`)
      : bad(`resource.cpu is ${cpu.severity}/${cpu.notify}/issueAfter=${cpu.issueAfter}`);
    /*
     * Not vacuous: worker.crash is high/ui_only, so an agent.repeat still
     * inheriting it would pass a severity check that only looked for "high".
     */
    repeat.notify !== ERROR_CLASSES["worker.crash"].notify
      ? ok("agent.repeat no longer takes worker.crash's position, which was silence")
      : bad("agent.repeat still notifies exactly as the fallback did");
    classify("something.nobody.defined") === ERROR_CLASSES["worker.crash"]
      ? ok("while a genuinely unknown category still falls back rather than throwing")
      : bad("the fallback for unknown categories is gone");

    console.log("");
    console.log("3. Issue + WhatsApp actually reaches WhatsApp");
    const repeatKey = `${KEY}-repeat`;
    const r1 = await raiseIssue(pool, {
      category: "agent.repeat", title: "an agent repeated itself in production",
      dedupeKey: repeatKey, now: T0,
    });
    r1.issueId ? ok("an Issue is opened the first time") : bad("no Issue for agent.repeat");
    const repeatRows = await outboxFor(repeatKey);
    repeatRows.some((r) => r.channel === "whatsapp")
      ? ok("and a WhatsApp row is queued, not only a console one")
      : bad(`queued only: ${repeatRows.map((r) => r.channel).join(", ") || "nothing"}`);
    (await issuesFor(repeatKey))[0]?.severity === "high"
      ? ok("the Issue carries the severity the taxonomy assigned")
      : bad("the Issue severity does not match the class");

    console.log("");
    console.log("4. Issue + ui_only stops at the console");
    const depKey = `${KEY}-dep`;
    const d1 = await raiseIssue(pool, {
      category: "dependency.unavailable", title: "the supplier API is not answering",
      dedupeKey: depKey, now: T0,
    });
    d1.issueId ? ok("an Issue is opened") : bad("no Issue for dependency.unavailable");
    const depRows = await outboxFor(depKey);
    depRows.length > 0 && depRows.every((r) => r.channel === "ui")
      ? ok("and nothing was queued for his phone")
      : bad(`reached ${depRows.map((r) => r.channel).join(", ")}`);

    console.log("");
    console.log("5. 'Issue if sustained' — a spike is not a defect");
    const cpuKey = `${KEY}-cpu`;
    const first = await raiseIssue(pool, {
      category: "resource.cpu", title: "cpu at 96%", dedupeKey: cpuKey, now: T0,
    });
    first.issueId === null
      ? ok("one spike opens no Issue")
      : bad("a single cpu spike went straight onto the Issue list");
    (await issuesFor(cpuKey)).length === 0
      ? ok("and nothing is sitting in the Issue table waiting to be promoted")
      : bad("a suppressed row was put on the list it is being kept off");
    first.notified
      ? ok("he is still told, at the level the class asks for")
      : bad("a busy machine went completely silent");

    const second = await raiseIssue(pool, {
      category: "resource.cpu", title: "cpu at 97%", dedupeKey: cpuKey, now: at(60_000),
    });
    second.issueId === null ? ok("twice is still not sustained") : bad("an Issue opened on the second report");
    /*
     * Two rows, not one. The Issue path keys its notification on the dedupe key
     * because an Issue is announced once; here there is deliberately one message
     * per occurrence, and reusing that key would let ON CONFLICT DO NOTHING
     * swallow every report after the first — leaving the console silent for
     * exactly the run-up this branch exists to describe.
     */
    (await outboxFor(cpuKey)).length === 2
      ? ok("and the second report is its own console message, not swallowed as a duplicate")
      : bad(`${(await outboxFor(cpuKey)).length} console messages for two reports`);

    const third = await raiseIssue(pool, {
      category: "resource.cpu", title: "cpu at 99%", dedupeKey: cpuKey, now: at(120_000),
    });
    third.issueId
      ? ok(`the third inside the window is sustained, and now it is an Issue`)
      : bad("a sustained episode never became an Issue");
    Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM issue_candidates WHERE dedupe_key = $1`, [cpuKey])).rows[0].n) === 0
      ? ok("the candidate is cleared once the Issue carries the count itself")
      : bad("the candidate row survives, so the next episode starts already at the threshold");

    console.log("");
    console.log("6. a quiet gap ends the episode");
    /*
     * Sustained has to mean it KEPT happening. Measured from the first
     * occurrence instead of the last, a class firing once an hour for a day
     * would eventually cross any threshold and report itself as sustained.
     */
    await pool.query(`UPDATE issues SET status = 'resolved' WHERE dedupe_key = $1`, [cpuKey]);
    const gapKey = `${KEY}-gap`;
    await raiseIssue(pool, { category: "resource.cpu", title: "cpu at 91%", dedupeKey: gapKey, now: T0 });
    await raiseIssue(pool, {
      category: "resource.cpu", title: "cpu at 92%", dedupeKey: gapKey, now: at(60_000),
    });
    const afterGap = await raiseIssue(pool, {
      category: "resource.cpu", title: "cpu at 93%",
      dedupeKey: gapKey, now: at(60_000 + SUSTAINED_WINDOW_MS + 1000),
    });
    afterGap.issueId === null
      ? ok(`a gap longer than ${SUSTAINED_WINDOW_MS / 60000} minutes restarts the count`)
      : bad("two spikes an hour apart plus one more counted as sustained");
    Number((await pool.query<{ occurrences: number }>(
      `SELECT occurrences FROM issue_candidates WHERE dedupe_key = $1`, [gapKey])).rows[0].occurrences) === 1
      ? ok("and the new episode is counting from one")
      : bad("the count carried across the gap");
  } finally {
    await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`, [`%${KEY}%`]);
    await pool.query(`DELETE FROM issues WHERE dedupe_key LIKE $1`, [`${KEY}%`]);
    await pool.query(`DELETE FROM issue_candidates WHERE dedupe_key LIKE $1`, [`${KEY}%`]);
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
