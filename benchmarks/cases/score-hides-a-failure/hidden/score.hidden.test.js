import test from "node:test";
import assert from "node:assert/strict";
import { score } from "../src/score.js";

const RIGHT = { correct: 1, tidy: 1, scoped: 1, reported: 1, cost: 120000 };
const WRONG_BUT_TIDY = { correct: 0, tidy: 1, scoped: 1, reported: 1, cost: 120000 };

// The reported complaint: process points carry a run that did not do the thing.
test("a run that failed the main check scores below one that passed", () => {
  assert.ok(score(WRONG_BUT_TIDY) < score(RIGHT));
});

test("and it scores badly in absolute terms, not merely lower", () => {
  assert.ok(score(WRONG_BUT_TIDY) < 0.6, `scored ${score(WRONG_BUT_TIDY)}`);
});

// Cost is recorded, not rewarded. Averaged in, a cheap wrong run beats a
// costly right one, and a token count dwarfs every other term.
test("spending less does not raise the score", () => {
  const cheapWrong = { ...WRONG_BUT_TIDY, cost: 10 };
  assert.ok(score(cheapWrong) < score(RIGHT));
});

test("the score stays within 0 and 1 whatever the cost", () => {
  const s = score(RIGHT);
  assert.ok(s >= 0 && s <= 1, `scored ${s}`);
});

// A run that did everything right scores full marks.
test("a correct run scores 1", () => {
  assert.equal(score(RIGHT), 1);
});

// The subtle one: a dimension that could not be measured is not a zero. Two
// runs that differ only in whether something was measurable must not be
// ranked by that.
test("an unmeasured dimension is excluded, not counted as failure", () => {
  const measured = { correct: 1, tidy: 1, scoped: 1, reported: 1, cost: null };
  const unmeasured = { correct: 1, tidy: 1, scoped: null, reported: 1, cost: null };
  assert.equal(score(measured), 1);
  assert.equal(score(unmeasured), 1);
});
