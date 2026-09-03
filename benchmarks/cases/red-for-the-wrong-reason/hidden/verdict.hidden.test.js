import test from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../src/verdict.js";

const PASSED = "# tests 4\n# pass 4\n# fail 0\n";
const ASSERTED = "# tests 4\n# pass 3\n# fail 1\nAssertionError [ERR_ASSERTION]: expected 3 to equal 4\n";
const NEVER_LOADED = "# tests 1\n# pass 0\n# fail 1\nReferenceError: require is not defined in ES module scope\n";
const SYNTAX = "# tests 1\n# pass 0\n# fail 1\nSyntaxError: The requested module does not provide an export named 'x'\n";
const NOTHING_FOUND = "# tests 0\n# pass 0\n# fail 0\n";

// The reported case.
test("a suite that never loaded did not run", () => {
  assert.equal(verdict(NEVER_LOADED, 1), "did_not_run");
});

// The ones a fix that only greps for the word would miss.
test("a genuine assertion failure is a failure", () => {
  assert.equal(verdict(ASSERTED, 1), "failed");
});

/*
 * The trap. A test can legitimately assert ON an error message, so the words
 * SyntaxError and ReferenceError appear in the output of a run that executed
 * perfectly well and failed an assertion. Deciding by substring alone calls
 * that a harness problem and quietly stops counting a real failure.
 */
test("an assertion that mentions a SyntaxError is still a failure", () => {
  const tricky = "# tests 4\n# pass 3\n# fail 1\n"
    + "AssertionError [ERR_ASSERTION]: expected the message to equal 'SyntaxError: bad input'\n";
  assert.equal(verdict(tricky, 1), "failed");
});

test("a syntax error in the file under test did not run", () => {
  assert.equal(verdict(SYNTAX, 1), "did_not_run");
});

/*
 * The second trap. Zero tests and exit code 0 is the shape of a green run, and
 * it is the most dangerous output a suite can produce: everything passes
 * because nothing ran.
 */
test("no tests at all is not a pass", () => {
  assert.equal(verdict(NOTHING_FOUND, 0), "did_not_run");
});

test("a clean run passed", () => {
  assert.equal(verdict(PASSED, 0), "passed");
});
