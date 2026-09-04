/**
 * A suite makes itself deterministic without cancelling everyone else's work.
 *
 * Twelve places cancelled every queued, preparing AND RUNNING task on the heavy
 * lane before doing anything — and `s2-task-create` did it for every lane. The
 * reason was real: `RUNNER_ONCE=1` claims the OLDEST queued task, so a leftover
 * from an earlier section took the slot and the task under test never ran.
 *
 * The remedy was worse than the fault. `deploy/compose.dev.yaml` pins
 * `name: jarvis-dev`, so every git worktree on this machine shares one compose
 * project — the same containers, the same database. Cancelling "everything
 * queued" reaches into other sessions' runs. It is what cancelled `s4-drain`'s
 * finished task and made a green run read red, and it is why suite results here
 * have been a coin flip whenever two sessions worked at once.
 *
 * `RUNNER_TASK_ID` removed the reason: a runner pointed at one task cannot claim
 * a leftover, so nothing has to be destroyed to make that true.
 *
 * THIS IS A RATCHET, NOT A CLEAN BILL OF HEALTH. Suites still to convert are
 * named in `PENDING` below, and the list may only get shorter: a name still
 * listed after it has been fixed FAILS, so the list cannot quietly rot into a
 * permanent exemption the way a hand-maintained list normally does.
 */
import fs from "node:fs/promises";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const NEWLINE = String.fromCharCode(10);
const DIR = new URL("../scripts/", import.meta.url);

/** Cancelling work this suite did not create. */
const STOMPS = /UPDATE\s+tasks\s+SET\s+state\s*=\s*'cancelled'[^;]{0,300}?state\s+IN\s*\(\s*'queued'/s;
/** Starting a runner of its own. */
const STARTS_RUNNER = "RUNNER_ONCE=1";
/** Pointing that runner at its own task. */
const TARGETS = "RUNNER_TASK_ID";

/*
 * Not yet converted, in either direction. Listed rather than fixed blind: a
 * suite changed without being run is a suite nobody has tested, and several of
 * these need a task id threaded through two or three launches.
 *
 * They fall into three kinds, and the second and third need more than
 * RUNNER_TASK_ID:
 *
 *   - starts a runner and clears the lane to get it: s11, s12, s18b-retrofit,
 *     s25, s14. RUNNER_TASK_ID is the whole answer; only the threading is left.
 *   - starts a runner and takes whatever is oldest without clearing anything:
 *     s3c-context, s4-recovery, s6-workflow. They do not stomp, but they are
 *     flaky for the same reason and get the same fix.
 *   - clears the lane for a VIEW rather than for a claim: s13-home,
 *     s15-journeys, s18-palette want the Work view to show their fixtures and
 *     nothing else. Targeting does not help them; the fix is to scope the
 *     cancel to their own project, which is a different change.
 *
 * `sweep.sh` clears the lane once at the start of a full run. On a dedicated box
 * that is reasonable; on this one it is the single biggest stomp there is.
 */
const PENDING = [
  "s11-recovery-test.sh",
  "s12-isolation-test.sh",
  "s14-live-detail-test.mjs",
  "s18b-retrofit-test.sh",
  "s25-routing-test.sh",
  "s3c-context-test.sh",
  "s6-workflow-test.sh",
  "s13-home-test.mjs",
  "s15-journeys-test.mjs",
  "s18-palette-test.mjs",
  "sweep.sh",
];

type Suite = { file: string; stomps: boolean; startsRunner: boolean; targets: boolean };

async function main(): Promise<void> {
  const files = (await fs.readdir(DIR))
    .filter((f) => /\.(sh|mjs|ts)$/.test(f) && f !== "queue-stomping-test.ts")
    .sort();

  const suites: Suite[] = [];
  for (const file of files) {
    const src = await fs.readFile(new URL(file, DIR), "utf8");
    /*
     * Comment lines excluded. Every converted suite now explains in prose what
     * it USED to cancel, and a naive search finds the explanation and calls it
     * the crime — the mistake that made the S39 wiring check match its own
     * comment.
     */
    const code = src.split(NEWLINE)
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join(NEWLINE);
    suites.push({
      file,
      stomps: STOMPS.test(code),
      startsRunner: code.includes(STARTS_RUNNER),
      targets: code.includes(TARGETS),
    });
  }

  console.log("1. the suites that start a runner point it at their own task");
  const runners = suites.filter((s) => s.startsRunner);
  runners.length > 0
    ? ok(`${runners.length} suites start a runner of their own`)
    : bad("nothing starts a runner, so this suite is asserting nothing");
  const untargeted = runners.filter((s) => !s.targets && !PENDING.includes(s.file));
  untargeted.length === 0
    ? ok("and every one outside the pending list names the task it wants")
    : bad(`starts a runner and takes whatever is oldest: ${untargeted.map((s) => s.file).join(", ")}`);

  console.log("");
  console.log("2. and none of them cancels work it did not create");
  const stompers = suites.filter((s) => s.stomps && !PENDING.includes(s.file));
  stompers.length === 0
    ? ok("no converted suite cancels a queue it does not own")
    : bad(`CANCELS OTHER SESSIONS' WORK: ${stompers.map((s) => s.file).join(", ")}`);

  console.log("");
  console.log("3. the pending list only gets shorter");
  /*
   * The half that stops a ratchet becoming an exemption. A name listed here
   * that no longer stomps is a stale entry, and a stale entry is how a
   * hand-maintained list starts lying — so it fails until somebody removes it.
   */
  const stale = PENDING.filter((name) => {
    const s = suites.find((x) => x.file === name);
    if (s === undefined) return false;
    const untargetedRunner = s.startsRunner && !s.targets;
    return !s.stomps && !untargetedRunner;
  });
  stale.length === 0
    ? ok(`all ${PENDING.length} pending suites still have one of the two problems, so the list is honest`)
    : bad(`fixed but still listed as pending, so the list has started lying: ${stale.join(", ")}`);
  const missing = PENDING.filter((name) => !suites.some((x) => x.file === name));
  missing.length === 0
    ? ok("and every name in it is a suite that exists")
    : bad(`named but not present: ${missing.join(", ")}`);

  console.log("");
  console.log("4. what is left");
  /*
   * Reported rather than asserted. The count is the work remaining, and printing
   * it is what keeps it visible in a sweep nobody reads line by line.
   */
  const converted = runners.filter((s) => s.targets).length;
  console.log(`  ${converted} of ${runners.length} runner-starting suites converted; `
    + `${PENDING.length} pending: ${PENDING.join(", ")}`);
  converted > 0
    ? ok(`${converted} converted so far`)
    : bad("nothing has been converted, so the mechanism is unused");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
