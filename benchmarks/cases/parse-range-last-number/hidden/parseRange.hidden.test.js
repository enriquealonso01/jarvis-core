import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/parseRange.js";

// The reported case.
test("the range includes its last number", () => {
  assert.deepEqual(parseRange("1-5"), [1, 2, 3, 4, 5]);
});

// A single-element range: off by one in the other direction returns [] here.
test("a range of one", () => {
  assert.deepEqual(parseRange("3-3"), [3]);
});

// What the seed already did right, and a careless fix can break.
test("a bare number still works", () => {
  assert.deepEqual(parseRange("7"), [7]);
});
test("nonsense is still rejected", () => {
  assert.throws(() => parseRange("abc"));
});
test("a backwards range is still rejected", () => {
  assert.throws(() => parseRange("9-2"));
});
