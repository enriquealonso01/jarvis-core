const { test } = require("node:test");
const assert = require("node:assert/strict");
const { slugify } = require("../src/slugify.js");

// The reported case.
test("no trailing dash", () => assert.equal(slugify("Hello World!"), "hello-world"));
// The ones a fix that only trims the end would miss.
test("no leading dash", () => assert.equal(slugify("!Hello"), "hello"));
test("inner runs collapse", () => assert.equal(slugify("a   b"), "a-b"));
test("all punctuation is empty, not a dash", () => assert.equal(slugify("!!!"), ""));
