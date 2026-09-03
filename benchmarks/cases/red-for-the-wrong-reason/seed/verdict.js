/**
 * Decide what a test run actually says.
 *
 * `output` is everything the runner printed; `exitCode` is what it returned.
 * The answer is one of "passed", "failed" or "did_not_run".
 *
 * "did_not_run" exists because a suite that never executed tells you nothing
 * about the code, and treating it as a verdict either way is how a broken
 * harness gets mistaken for a broken program.
 */
export function verdict(output, exitCode) {
  return exitCode === 0 ? "passed" : "failed";
}
