/**
 * Decide what a test run actually says.
 *
 * `output` is everything the runner printed; `exitCode` is what it returned.
 * The answer is one of "passed", "failed" or "did_not_run".
 *
 * "did_not_run" exists because a suite that never executed tells you nothing
 * about the code, and treating it as a verdict either way is how a broken
 * harness gets mistaken for a broken program.
 *
 * Order matters more than the patterns do. An assertion failure is checked
 * BEFORE the load-error patterns, because a test may legitimately assert on an
 * error message - so "SyntaxError" appears in the output of a run that executed
 * perfectly and failed honestly. Substring matching alone reads that as a
 * harness problem and stops counting a real failure.
 */
const LOAD_ERROR = /SyntaxError|ReferenceError|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/;

export function verdict(output, exitCode) {
  const counted = /# tests (\d+)/.exec(output);
  const tests = counted ? Number(counted[1]) : 0;

  // Nothing ran. Exit code 0 here is the most misleading green there is.
  if (tests === 0) return "did_not_run";

  if (exitCode === 0) return "passed";
  if (/AssertionError/.test(output)) return "failed";
  if (LOAD_ERROR.test(output)) return "did_not_run";
  return "failed";
}
