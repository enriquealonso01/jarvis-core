/**
 * S33 — three staleness classes, or one behaviour with three names.
 *
 *   "An Issue of each staleness class, left unresolved for a fortnight: the
 *    `wait` one is silent, the `re-raise` one appears in the weekly report with
 *    its age and its count, the `block` one has stopped other work. **All
 *    three**, or the policy is one behaviour with three names."
 *
 * That last clause is the assertion this suite is built around, so the three
 * are compared against EACH OTHER rather than checked one at a time. A suite
 * that asserts "the re-raise one appears in the report" and separately "the
 * block one blocks" passes on a system where all three do both — which is the
 * failure being described.
 */
import { createPool } from "../src/db.js";
import {
  blockingIssues, DEFAULT_STALENESS, markReRaised, needsYou, reRaiseLine,
  stalenessFor, weeklyReRaises,
} from "../src/staleness.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const TAG = `s33st-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  try {
    /** An Issue of a given class, aged a fortnight. */
    const raise = async (
      category: string, title: string, occurrences: number, ageDays: number,
    ) => (await pool.query<{ id: string }>(
      `INSERT INTO issues (severity, category, status, owner, title, dedupe_key,
                           staleness, occurrences, created_at, updated_at)
       VALUES ('high',$1,'waiting_for_user','user',$2,$3,$4,$5,
               now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval)
       RETURNING id`,
      [category, title, `${TAG}:${category}`, stalenessFor(category), occurrences, String(ageDays)],
    )).rows[0].id;

    console.log("1. the classes are decided by whether waiting costs anything");
    stalenessFor("setup.pending") === "wait"
      ? ok("an auth-shaped Issue waits — nothing degrades while he decides")
      : bad(`setup.pending is ${stalenessFor("setup.pending")}`);
    stalenessFor("backup.failure") === "re-raise"
      ? ok("a failing backup re-raises — it costs more every day")
      : bad(`backup.failure is ${stalenessFor("backup.failure")}`);
    stalenessFor("security.isolation") === "block"
      ? ok("an isolation breach blocks — waiting is not acceptable at all")
      : bad(`security.isolation is ${stalenessFor("security.isolation")}`);
    /*
     * Not importance. `setup.pending` is high severity and still waits, which is
     * the distinction the plan draws and the one an implementation gets wrong by
     * reaching for severity because it is already there.
     */
    stalenessFor("setup.pending") !== stalenessFor("backup.failure")
      ? ok("and two high-severity categories land in different classes, so it is not severity wearing a hat")
      : bad("the classes track severity rather than cost-of-waiting");

    console.log("");
    console.log("2. an unclassified category is not silent");
    DEFAULT_STALENESS === "re-raise"
      ? ok("a category nobody classified defaults to re-raise, not to silence")
      : bad(`the default is ${DEFAULT_STALENESS}`);
    stalenessFor("something.nobody.wrote") === "re-raise"
      ? ok("so the backup that has been failing for a month cannot be quiet because a row was missing")
      : bad("an unknown category is not re-raised");
    /*
     * And the categories every object already has. A bare index returns
     * something TRUTHY for an inherited key, so `?? DEFAULT` never fires and
     * this returned a FUNCTION where a Staleness is promised - which then goes
     * into `issues.staleness` and its CHECK constraint, turning a
     * classification into a database error while an Issue is being raised
     * about something else.
     */
    ["constructor", "toString", "__proto__", "valueOf"]
      .every((k) => stalenessFor(k) === "re-raise")
      ? ok("including constructor, toString, __proto__ and valueOf, which are categories no one wrote either")
      : bad(`an inherited key returned ${["constructor", "toString"].map((k) => String(stalenessFor(k)).slice(0, 20)).join(" / ")}`);

    console.log("");
    console.log("3. a fortnight later, the three behave differently");
    const waitId = await raise("setup.pending", `${TAG} connect the supplier account`, 1, 14);
    const reraiseId = await raise("backup.failure", `${TAG} backup has failed`, 9, 14);
    const blockId = await raise("security.isolation", `${TAG} cross-project read`, 1, 14);

    const report = await weeklyReRaises(pool);
    const mine = report.filter((r) => r.issue.title.startsWith(TAG));
    const blocked = (await blockingIssues(pool)).filter((i) => i.title.startsWith(TAG));

    const inReport = (id: string) => mine.some((r) => r.issue.id === id);
    const isBlocking = (id: string) => blocked.some((i) => i.id === id);

    !inReport(waitId) && !isBlocking(waitId)
      ? ok("the wait one is silent: not in the report, not blocking")
      : bad("the wait Issue nagged or blocked");
    inReport(reraiseId) && !isBlocking(reraiseId)
      ? ok("the re-raise one is in the weekly report, and has stopped nothing")
      : bad(`the re-raise Issue: report=${inReport(reraiseId)} blocking=${isBlocking(reraiseId)}`);
    isBlocking(blockId) && !inReport(blockId)
      ? ok("the block one has stopped other work, and is not also in the report")
      : bad(`the block Issue: report=${inReport(blockId)} blocking=${isBlocking(blockId)}`);
    /*
     * The clause the suite exists for. Three distinct (in-report, blocking)
     * pairs is what "three behaviours" means; anything less is one behaviour
     * with three names.
     */
    const shape = (id: string) => `${inReport(id) ? "R" : "-"}${isBlocking(id) ? "B" : "-"}`;
    new Set([shape(waitId), shape(reraiseId), shape(blockId)]).size === 3
      ? ok(`all three outcomes differ: wait=${shape(waitId)} re-raise=${shape(reraiseId)} block=${shape(blockId)}`)
      : bad(`the classes are not three behaviours: ${shape(waitId)} ${shape(reraiseId)} ${shape(blockId)}`);

    console.log("");
    console.log("4. the report line says its age and its count");
    const line = mine.find((r) => r.issue.id === reraiseId)?.line ?? "";
    line.includes("14 days") && line.includes("9 occurrence")
      ? ok(`"${line}"`)
      : bad(`the line does not carry age and count: "${line}"`);

    console.log("");
    console.log("5. re-raised, it says what CHANGED rather than repeating itself");
    await markReRaised(pool, [reraiseId]);
    const unchanged = (await weeklyReRaises(pool)).find((r) => r.issue.id === reraiseId)?.line ?? "";
    unchanged.includes("unchanged since you last saw it")
      ? ok(`with nothing new, it says so rather than repeating the same sentence: "${unchanged}"`)
      : bad(`the second line is: "${unchanged}"`);
    await pool.query(`UPDATE issues SET occurrences = occurrences + 4 WHERE id = $1`, [reraiseId]);
    const changed = (await weeklyReRaises(pool)).find((r) => r.issue.id === reraiseId)?.line ?? "";
    changed.includes("4 more times since you last saw it")
      ? ok(`and when it has recurred, it says how many times: "${changed}"`)
      : bad(`the changed line is: "${changed}"`);
    changed !== unchanged
      ? ok("so the sentence he already ignored is not the sentence he gets next")
      : bad("the re-raised line is identical to the one before");

    console.log("");
    console.log("6. Needs You sorts oldest first");
    await raise("approval.pending", `${TAG} newest`, 1, 1);
    const queue = (await needsYou(pool)).filter((i) => i.title.startsWith(TAG));
    queue[0]?.ageDays >= (queue[queue.length - 1]?.ageDays ?? 0)
      ? ok(`the oldest is first (${queue.map((i) => `${i.ageDays}d`).join(", ")})`)
      : bad(`Needs You is ordered ${queue.map((i) => `${i.ageDays}d`).join(", ")}`);
    queue[queue.length - 1]?.title.endsWith("newest")
      ? ok("and the one raised today is last, because the oldest is the one being ignored")
      : bad("the newest item is not last");
  } finally {
    await pool.query(`DELETE FROM issues WHERE dedupe_key LIKE $1 OR title LIKE $2`,
      [`${TAG}:%`, `${TAG}%`]);
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
