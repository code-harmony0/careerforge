// extension/tests/verdict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../lib/verdict.js";

test("parses a full VERDICT line with summary", () => {
  const r = parseVerdict("blah\nVERDICT: 4.5/5 — Strong match, apply soon\nblah");
  assert.equal(r.score, 4.5);
  assert.equal(r.summary, "Strong match, apply soon");
});

test("falls back to a bare X/5 pattern with no summary", () => {
  const r = parseVerdict("Overall this scores 3.5/5 based on the criteria.");
  assert.equal(r.score, 3.5);
  assert.equal(r.summary, "");
});

test("returns null score when nothing matches", () => {
  const r = parseVerdict("no score here");
  assert.equal(r.score, null);
});
