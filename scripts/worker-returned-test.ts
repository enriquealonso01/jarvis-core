/**
 * A suite that borrows the worker gives it back.
 *
 * This has now been found three times, and each time it looked like a code
 * regression rather than a borrowed service: `s4-recovery`, `s4-drain` and
 * `s11-recovery` each stopped the shared worker so they could read a state
 * nothing was still changing, and then left it stopped. Every suite after them
 * in `sweep.sh` — roughly ninety of about a hundred — ran with no worker at all,
 * and reported failures that had nothing to do with what it was testing.
 *
 * It was measured once, by starting the worker and changing no code:
 *
 *   s1-harness 16/7 -> 23/0, s2-task-create 21/3 -> 24/0, s3-routing 28/2 ->
 *   30/0, s4-drain 6/5 -> 11/0, s11-recovery 14/12 -> 26/0.
 *
 * Twenty-nine false failures from one stopped container. So the rule is checked
 * rather than remembered, and it is checked by DISCOVERY: every `.sh` in
 * scripts/ that stops or removes the worker must also start it again, and the
 * start must come after the last stop. A hand-written list of the three suites
 * that do this today would be silently wrong about the fourth.
 *
 * Deliberately a source check, not a runtime one. Asserting "the worker is up
 * right now" passes on a box where nobody has run the offending suite yet, which
 * is exactly the condition under which this bug hides.
 */
import fs from "node:fs/promises";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const NEWLINE = String.fromCharCode(10);

/* What counts as taking the worker away, and what counts as giving it back. */
const TAKES = ["stop worker", "rm -f worker", "rm worker", "stop -t 0 worker"];
const GIVES = "up -d --no-build worker";

type Borrower = { file: string; lastTake: number; give: number; trapped: boolean };

/**
 * Where the give-back is allowed to sit.
 *
 * A textual "after the last stop" rule is wrong here, and wrongly failed all
 * three suites on the first run: every one of them gives the worker back from a
 * `cleanup()` registered with `trap cleanup EXIT`, which is DEFINED at the top
 * of the file and RUNS last. Position in the file says nothing about order of
 * execution once a trap is involved, so the trap is modelled rather than
 * ignored.
 */
function exitTrapBody(code: string): [number, number] | null {
  const trap = /trap\s+([A-Za-z_][A-Za-z0-9_]*)\s+EXIT/.exec(code);
  if (!trap) return null;
  const start = code.indexOf(`${trap[1]}() {`);
  if (start < 0) return null;
  const end = code.indexOf(`${NEWLINE}}`, start);
  return end < 0 ? null : [start, end];
}

async function main(): Promise<void> {
  const dir = new URL("../scripts/", import.meta.url);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sh")).sort();

  const borrowers: Borrower[] = [];
  for (const file of files) {
    const src = await fs.readFile(new URL(file, dir), "utf8");
    /*
     * Comment lines excluded. Every one of these scripts now explains in prose
     * WHY it stops the worker, and a naive search finds the explanation and
     * calls it a borrow — the same mistake that made the S39 wiring check match
     * its own comment.
     */
    const code = src.split(NEWLINE)
      .filter((l) => !/^\s*#/.test(l)).join(NEWLINE);
    const lastTake = Math.max(...TAKES.map((t) => code.lastIndexOf(t)));
    if (lastTake < 0) continue;
    /*
     * The give-back is the LAST start that actually runs last: one after the
     * final stop, or one inside the EXIT trap. Picking `lastIndexOf` blindly
     * found s4-drain's own fixture start - the one that borrows the worker with
     * a five-second watchdog - and reported the borrow as the return.
     */
    const trap = exitTrapBody(code);
    let give = -1;
    let trapped = false;
    for (let at = code.indexOf(GIVES); at >= 0; at = code.indexOf(GIVES, at + 1)) {
      const inTrap = trap !== null && at > trap[0] && at < trap[1];
      if (at > lastTake || inTrap) { give = at; trapped = inTrap; }
    }
    borrowers.push({ file, lastTake, give, trapped });
  }

  console.log("1. the suites that borrow the worker");
  borrowers.length > 0
    ? ok(`${borrowers.length} of ${files.length} scripts stop or remove it: ${borrowers.map((b) => b.file.replace("-test.sh", "")).join(", ")}`)
    : bad("nothing borrows the worker, so this suite is asserting nothing");

  console.log("");
  console.log("2. and every one of them gives it back");
  const kept = borrowers.filter((b) => b.give < 0);
  kept.length === 0
    ? ok("no suite leaves the worker stopped for the ninety that follow it")
    : bad(`SUITES THAT TAKE THE WORKER AND KEEP IT: ${kept.map((b) => b.file).join(", ")}`);

  /*
   * Ordering, not just presence: a restart that runs before the last stop reads
   * as a fix and is not one, because the suite still ends with the worker down.
   * An EXIT trap satisfies it wherever it is written, which is how all three of
   * these are actually built.
   */
  const backwards = borrowers.filter((b) => b.give >= 0 && !b.trapped && b.give < b.lastTake);
  backwards.length === 0
    ? ok(`it runs after the last stop (${borrowers.filter((b) => b.trapped).length} of them from an EXIT trap, so a failing suite returns it too)`)
    : bad(`restarted too early, so it still ends stopped: ${backwards.map((b) => b.file).join(", ")}`);

  console.log("");
  console.log("3. the restart is an ordinary worker, not the borrower's fixture");
  /*
   * `s4-drain` and `s11-recovery` both start the worker with
   * JARVIS_STALL_SECONDS=5 for their own purposes. Handing that back would give
   * every later suite a watchdog five times more eager than production's, which
   * is a subtler version of the same fault: the next suite inherits a service it
   * did not ask for.
   */
  const withFixtureEnv: string[] = [];
  for (const b of borrowers) {
    if (b.give < 0) continue;
    const src = await fs.readFile(new URL(b.file, dir), "utf8");
    const code = src.split(NEWLINE).filter((l) => !/^\s*#/.test(l)).join(NEWLINE);
    // The give-back's own line, not the file's last one.
    const from = code.lastIndexOf(NEWLINE, b.give) + 1;
    if (code.slice(from, b.give).includes("JARVIS_STALL_SECONDS")) withFixtureEnv.push(b.file);
  }
  withFixtureEnv.length === 0
    ? ok("the worker handed back has the default stall seconds")
    : bad(`hands back a fixture worker: ${withFixtureEnv.join(", ")}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
