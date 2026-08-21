// extension/tests/extract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseWhitespace, capText } from "../lib/extract.js";

test("collapseWhitespace squashes runs of whitespace to single spaces", () => {
  assert.equal(collapseWhitespace("a\n\n  b\t\tc"), "a b c");
});

test("collapseWhitespace trims leading/trailing whitespace", () => {
  assert.equal(collapseWhitespace("  hello world  "), "hello world");
});

test("capText leaves short text untouched", () => {
  assert.equal(capText("short", 100), "short");
});

test("capText truncates long text to the exact cap length", () => {
  const long = "x".repeat(200);
  const capped = capText(long, 100);
  assert.equal(capped.length, 100);
});
