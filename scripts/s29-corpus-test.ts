/**
 * The corpus has to be able to fail.
 *
 * "If every candidate scores the same, the cases are too easy" - and a case
 * whose hidden tests PASS against the unfixed seed is worse than easy: every
 * engine scores full marks for changing nothing. So each case is checked by
 * actually running its hidden suite against its own seed and requiring red.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCases, caseIsFailable, caseIsGradeable } from "../src/benchmark.js";

const run = promisify(execFile);
let fails = 0;
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** Whether the suite passed, and what it printed - the output decides WHY it failed. */
async function nodeTestVerbose(cwd: string): Promise<{ passed: boolean; output: string }> {
  return await run("node", ["--test"], { cwd, timeout: 60_000 })
    .then((r) => ({ passed: true, output: `${r.stdout}${r.stderr}` }))
    .catch((e: { stdout?: string; stderr?: string }) => ({
      passed: false,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    }));
}

/** True when the suite passed. */
async function nodeTest(cwd: string): Promise<boolean> {
  /*
   * No path argument: node 22 treats `--test test/` as a FILE and dies with
   * "Cannot find module /tmp/.../test" - which the check counted as the case
   * failing. Every case looked failable, including one whose seed was already
   * fixed. Discovery from the working directory is what actually runs them.
   */
  return await run("node", ["--test"], { cwd, timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
}

async function main() {
  const cases = await loadCases("benchmarks");

  console.log("1. the corpus loads");
  cases.length >= 2 ? ok(`${cases.length} cases: ${cases.map((c) => c.id).join(", ")}`)
    : bad(`only ${cases.length} case(s) found`);

  console.log("2. every case states what a correct fix touches");
  /*
   * Guarded on there being cases at all. Written without this it read "all
   * cases name their expected files" over an empty list and passed - the same
   * vacuous green the corpus itself exists to prevent.
   */
  const noFiles = cases.filter((c) => !c.expectedFiles?.length);
  cases.length > 0 && noFiles.length === 0
    ? ok("all cases name their expected files")
    : bad(cases.length === 0
        ? "no cases loaded, so this asserted nothing"
        : `${noFiles.map((c) => c.id).join(", ")} name none - scope control cannot be scored`);

  console.log("3. every case FAILS against its own seed");
  for (const c of cases) {
    const v = await caseIsFailable(c, nodeTest);
    v.failable ? ok(`${c.id}: ${v.detail}`) : bad(`${c.id}: ${v.detail}`);
  }

  console.log("4. a case that cannot fail is caught");
  // Otherwise assertion 3 is a green light that proves nothing: it would pass
  // just as happily if the check always returned failable.
  if (!cases.length) { console.log("  SKIP  no cases to build a sham from"); }
  const sham = { ...cases[0], id: "sham", dir: cases[0]?.dir ?? "" };
  const alwaysPasses = await caseIsFailable(sham, async () => true);
  !alwaysPasses.failable
    ? ok("a seed the hidden tests pass against is reported as not failable")
    : bad("the failability check cannot tell a passing seed from a failing one");

  console.log("5. every case is gradeable in BOTH directions");
  /*
   * Red on the seed is half a case. slug-trailing-dash shipped a CommonJS seed
   * while the harness writes "type": "module", so its hidden suite died on
   * `require is not defined` before a single test ran - and assertion 3 called
   * that a good case, because it had watched it go red. Every run of that case
   * scored hidden_tests 0 whatever the agent wrote.
   */
  for (const c of cases) {
    const g = await caseIsGradeable(c, nodeTestVerbose);
    g.gradeable ? ok(`${c.id}: ${g.detail}`) : bad(`${c.id}: ${g.detail}`);
  }

  console.log("6. a case that fails without running is not gradeable");
  const broken = { ...cases[0], id: "broken", dir: cases[0]?.dir ?? "" };
  const loadError = await caseIsGradeable(broken, async () => ({
    passed: false,
    output: "ReferenceError: require is not defined in ES module scope",
  }));
  !loadError.gradeable && loadError.detail.includes("without running")
    ? ok("a suite that dies before any test runs is rejected, not counted as red")
    : bad("a load error was accepted as proof the case fails");

  // Red by assertion in both directions: the seed gate is satisfied, so the
  // only thing left to reject it is that the reference fix cannot pass either.
  const unreachable = await caseIsGradeable(broken, async () => ({
    passed: false,
    output: "AssertionError [ERR_ASSERTION]: expected 3 to equal 4",
  }));
  !unreachable.gradeable && unreachable.detail.includes("known-good fix")
    ? ok("and a case its own reference fix cannot pass is rejected")
    : bad("a case that nobody can pass was accepted");

  const noAssertion = await caseIsGradeable(broken, async () => ({
    passed: false,
    output: "# fail 1",
  }));
  !noAssertion.gradeable && noAssertion.detail.includes("nothing asserted")
    ? ok("and red with no assertion behind it is rejected - a failed test count is not a reason")
    : bad("a red run with no assertion was accepted as a genuine failure");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
