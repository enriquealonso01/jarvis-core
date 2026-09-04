/**
 * S46, wired: leaving the running family releases the seat.
 *
 * S46 shipped the rule and a suite that proves it — through `parkForAuth`, which
 * nothing calls. The live paths go through `transitionTask`, and nine of them
 * released the lease by passing `lease_until = NULL` and leaving `lease_owner`
 * set. That is not a smaller version of the fix, it is the opposite of one:
 * `reconcileExpiredLeases` finds abandoned leases by looking for an expiry in
 * the past, so nulling the expiry and keeping the owner puts the row beyond the
 * reach of the only sweep that would ever have cleared it.
 *
 *   "**Parking releases the lane.** A parked task is not running, and holding a
 *    worker slot while waiting on a human turns a handful of unauthenticated
 *    connections into a starved queue (ADR 007)."
 *
 * and the plan's own instruction about how to check it:
 *
 *   "Park five tasks on auth → the queue keeps running. **Assert on lanes free,
 *    not on the parked tasks looking calm.**"
 *
 * So this asserts on `lanesInUse` across the REAL transition path, on the
 * database refusing to store the lie at all, and — at source level — that no
 * caller can go back to describing the release in a string, because that is the
 * convention that failed nine times out of ten.
 */
import fs from "node:fs/promises";
import { createPool } from "../src/db.js";
import { LEASE_STATES, transitionTask } from "../src/jobs.js";
import { lanesInUse } from "../src/handoff.js";
import { reconcileExpiredLeases } from "../src/selfwatch.js";
import { deleteProjects } from "./_teardown.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s46l-${Math.random().toString(36).slice(2, 8)}`;
/* Built from a char code: an escape written here has been eaten five times. */
const NEWLINE = String.fromCharCode(10);

/* Every state a task can end in that is not one of the four that hold a seat. */
const LEAVING = [
  "queued", "waiting_for_provider", "waiting_for_user", "waiting_for_approval",
  "paused", "stalled", "retry_scheduled", "succeeded", "failed_terminal", "cancelled",
];

async function main(): Promise<void> {
  const tasks: string[] = [];
  let project = "";
  try {
    project = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug, name, project_type) VALUES ($1,$1,'personal') RETURNING id`,
      [SLUG])).rows[0].id;
    const running = async (title: string): Promise<string> => {
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, state, priority, lane, lease_owner, lease_until)
         VALUES ($1,$2,'running','normal','heavy','worker-1', now() + interval '5 minutes')
         RETURNING id`, [project, title])).rows[0].id;
      tasks.push(id);
      return id;
    };

    console.log("1. every way out of the running family gives the seat back");
    /*
     * Driven through transitionTask — the function the runner, the watchdog and
     * the worker all actually call — rather than through parkForAuth, which is
     * what S46's own suite proves and what nothing in the live system reaches.
     */
    const held: string[] = [];
    for (const state of LEAVING) {
      const id = await running(`${SLUG} leaving to ${state}`);
      await transitionTask(pool, id, state, "s46 lease wiring", "test");
      const row = (await pool.query<{ state: string; lease_owner: string | null }>(
        `SELECT state, lease_owner FROM tasks WHERE id = $1`, [id])).rows[0];
      if (row.state !== state) bad(`the transition to ${state} did not happen`);
      else if (row.lease_owner !== null) held.push(state);
    }
    held.length === 0
      ? ok(`all ${LEAVING.length} destinations released the seat`)
      : bad(`STILL HOLDING A SEAT AFTER: ${held.join(", ")}`);

    /*
     * And the other direction, or the assertion above is satisfied by a function
     * that clears the lease unconditionally — which would take a task away from
     * a process still working on it.
     */
    const stillWorking = await running(`${SLUG} still working`);
    await transitionTask(pool, stillWorking, "waiting_for_tool", "mid-run", "test");
    (await pool.query<{ lease_owner: string | null }>(
      `SELECT lease_owner FROM tasks WHERE id = $1`, [stillWorking])).rows[0].lease_owner === "worker-1"
      ? ok("while a task still inside the run keeps the seat it is using")
      : bad("the lease was cleared from a task a worker is still attached to");
    LEASE_STATES.length === 4
      ? ok(`and the holding states are a closed set: ${LEASE_STATES.join(", ")}`)
      : bad(`holding states: ${LEASE_STATES.join(", ")}`);

    console.log("");
    console.log("2. the lane, not the tasks looking calm");
    const parked: string[] = [];
    for (let i = 0; i < 5; i += 1) parked.push(await running(`${SLUG} awaiting auth ${i}`));
    const before = await lanesInUse(pool, "heavy");
    before >= 5 ? ok(`${before} heavy seats held`) : bad(`the fixtures hold no seats: ${before}`);
    for (const id of parked) {
      await transitionTask(pool, id, "waiting_for_user", "waiting on a person", "runner");
    }
    const after = await lanesInUse(pool, "heavy");
    after === before - 5
      ? ok(`all five came back through the live path: ${before} -> ${after}`)
      : bad(`seats held after parking: ${after}, was ${before}`);

    console.log("");
    console.log("3. the half-release that was worse than none");
    /*
     * WHY THIS WAS INVISIBLE FOR SO LONG. The old callers nulled the expiry and
     * kept the owner. reconcileExpiredLeases only looks at rows whose expiry is
     * in the past, so those rows were unreachable by the sweep forever.
     * Asserted on the sweep's own behaviour rather than by reading its WHERE.
     */
    const orphan = await running(`${SLUG} half released`);
    await pool.query(`UPDATE tasks SET lease_until = NULL WHERE id = $1`, [orphan]);
    const swept = await reconcileExpiredLeases(pool);
    (await pool.query<{ lease_owner: string | null }>(
      `SELECT lease_owner FROM tasks WHERE id = $1`, [orphan])).rows[0].lease_owner === "worker-1"
      ? ok(`the sweep cannot reach an owner with no expiry (${swept} swept), which is why it had to stop being created`)
      : ok("the sweep reaches it as well now");
    await transitionTask(pool, orphan, "failed_terminal", "s46 lease wiring", "test");
    (await pool.query<{ lease_owner: string | null }>(
      `SELECT lease_owner FROM tasks WHERE id = $1`, [orphan])).rows[0].lease_owner === null
      ? ok("and leaving releases it regardless of what the expiry says")
      : bad("the half-released row survived the transition");

    console.log("");
    console.log("4. the database cannot store the lie, and does not punish anyone for trying");
    /*
     * The repair is what makes this stay fixed. Without it the rule lives in one
     * function that a future caller routes around with a raw UPDATE — which is
     * exactly how the five raw UPDATEs in src/ came to exist.
     *
     * REPAIRED, NOT REJECTED, and the difference was measured rather than
     * reasoned about. The first version was a bare CHECK, and the statement it
     * rejected was the one FINISHING the work: a task whose harness had run
     * cleanly ended at `worker.crash`, still `running`, because the UPDATE that
     * would have marked it `succeeded` was refused. A leaked lease is
     * bookkeeping; a lost run is work.
     */
    const guarded = await running(`${SLUG} repair`);
    let refused = "";
    await pool.query(`UPDATE tasks SET state = 'succeeded' WHERE id = $1`, [guarded])
      .catch((e: Error) => { refused = e.message; });
    refused === ""
      ? ok("a raw UPDATE that forgets the seat is not punished for it")
      : bad(`the write was rejected instead of repaired: ${refused}`);
    const repaired = (await pool.query<{ state: string; lease_owner: string | null }>(
      `SELECT state, lease_owner FROM tasks WHERE id = $1`, [guarded])).rows[0];
    repaired.state === "succeeded" && repaired.lease_owner === null
      ? ok("the work is recorded as finished AND the seat came back, from one statement that asked for neither")
      : bad(`after a forgetful UPDATE: state=${repaired.state} owner=${repaired.lease_owner}`);
    /*
     * And the repair is about LEAVING, not about every write — otherwise it
     * would be taking seats from live workers, which is the failure the
     * `waiting_for_tool` case above guards.
     */
    const busy = await running(`${SLUG} busy`);
    await pool.query(`UPDATE tasks SET phase = 'editing' WHERE id = $1`, [busy]);
    (await pool.query<{ lease_owner: string | null }>(
      `SELECT lease_owner FROM tasks WHERE id = $1`, [busy])).rows[0].lease_owner === "worker-1"
      ? ok("while an ordinary write to a running task leaves its seat alone")
      : bad("the repair took a seat from a running task");
    /*
     * The CHECK underneath is the assertion that the repair happened. It is
     * unreachable while the trigger is in place, which is the point, so what is
     * asserted here is that it EXISTS — a repair with nothing behind it is a
     * rule that quietly stops being true when somebody drops the trigger.
     */
    const guards = (await pool.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_lease_only_while_working'
        UNION ALL
       SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'tasks'::regclass AND tgname = 'tasks_release_lease_on_leaving'`)).rows;
    guards.length === 2
      ? ok("with both halves in place: the repair, and the check that proves it ran")
      : bad(`only ${guards.map((g) => g.name).join(", ") || "nothing"} guards the invariant`);

    console.log("");
    console.log("5. nobody can go back to describing the release in a string");
    /*
     * The convention failed nine times out of ten, so the check is that the
     * convention is GONE — not that today's callers happen to be right. Read at
     * source, the way s27-config-test holds "only one file writes a version
     * row"; a suite that called transitionTask and looked at the row would pass
     * with every one of those nine callers still wrong.
     */
    const dir = new URL("../src/", import.meta.url);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(new URL(f, dir), "utf8");
      const code = src.split(NEWLINE)
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(NEWLINE);
      for (const call of code.split("transitionTask(").slice(1)) {
        const args = call.slice(0, call.indexOf(");"));
        if (args.includes("lease_owner = NULL") || args.includes("lease_until = NULL")) {
          offenders.push(`${f}: ${args.split(NEWLINE).join(" ").slice(0, 70)}`);
        }
      }
    }
    offenders.length === 0
      ? ok(`no caller in ${files.length} source files hand-writes a lease release`)
      : bad(`callers still describing the release: ${offenders.join(" | ")}`);
    /*
     * The one lease assignment left is deliberate and is not a release: the
     * recovery ladder sets a cooling-off expiry in the same statement, because a
     * queued task whose lease_until is in the future is the only scheduler a
     * rung's backoff has. Written BEFORE the transition it was wiped by it.
     */
    const ladder = await fs.readFile(new URL("../src/ladder.ts", import.meta.url), "utf8");
    /*
     * Scoped to the function, not the file. `indexOf` over the whole of
     * ladder.ts finds the FIRST transitionTask call, which is in a different
     * rung entirely, so the comparison was about two unrelated lines and
     * reported a failure that was not one.
     */
    const fn = ladder.slice(ladder.indexOf("async function requeue"));
    const body = fn.slice(0, fn.indexOf(`${NEWLINE}}`));
    body.includes("make_interval") && body.indexOf("make_interval") > body.indexOf("transitionTask(")
      ? ok("and the ladder's backoff rides along with the transition rather than before it")
      : bad("the backoff is written in a statement the transition then wipes");

    console.log("");
    console.log("6. and the database has no leftovers");
    /*
     * The whole point, measured where it read 88. Deliberately unscoped: a
     * leaked seat anywhere is a seat.
     */
    const leaked = (await pool.query<{ state: string; n: string }>(
      `SELECT state, count(*) AS n FROM tasks
        WHERE lease_owner IS NOT NULL AND state <> ALL($1::text[])
        GROUP BY state`, [LEASE_STATES])).rows;
    leaked.length === 0
      ? ok("no task anywhere owns a seat it is not sitting in")
      : bad(`leaked seats: ${leaked.map((r) => `${r.state}=${r.n}`).join(", ")}`);
  } finally {
    if (tasks.length) {
      await pool.query(`UPDATE tasks SET lease_owner = NULL WHERE id = ANY($1::uuid[])`, [tasks])
        .catch(() => undefined);
      await pool.query(`DELETE FROM task_transitions WHERE task_id = ANY($1::uuid[])`, [tasks]);
      await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [tasks]);
    }
    /*
     * The FK graph, discovered rather than listed: activity_events points at the
     * project and a hand-written DELETE found that out the hard way.
     */
    if (project) await deleteProjects(pool, [project]);
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
