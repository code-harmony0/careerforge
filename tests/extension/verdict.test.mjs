// extension/tests/verdict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, scoreTone } from "../../extension/lib/verdict.js";

test("parses a full VERDICT line with summary", () => {
  const r = parseVerdict("blah\nVERDICT: 4.5/5 — Strong match, apply soon\nblah");
  assert.equal(r.score, 4.5);
  assert.equal(r.summary, "Strong match, apply soon");
});

test("parses bold **VERDICT:** lines with various markdown delimiters", () => {
  const r1 = parseVerdict("**VERDICT:** 4.3/5 — Exceptional fit");
  assert.equal(r1.score, 4.3);
  assert.equal(r1.summary, "Exceptional fit");

  const r2 = parseVerdict("**VERDICT: 4.2/5** - Decent match");
  assert.equal(r2.score, 4.2);
  assert.equal(r2.summary, "Decent match");

  const r3 = parseVerdict("VERDICT: 4.0/5");
  assert.equal(r3.score, 4.0);
  assert.equal(r3.summary, "");
});

test("parses report markdown headers and decision lead sentences", () => {
  const md = `# Evaluation: Quixta — Senior React Native Developer
**Date:** 2026-11-05
**Score:** 4.3/5
**Decision:** Apply

**Apply.** Strong technical match on React Native architecture and performance tuning.
`;
  const r = parseVerdict(md);
  assert.equal(r.score, 4.3);
  assert.equal(r.summary, "Strong technical match on React Native architecture and performance tuning.");
});

test("parses Machine Summary YAML blocks", () => {
  const md = `## Machine Summary
\`\`\`yaml
score: 4.1
final_decision: "Apply"
\`\`\`
`;
  const r = parseVerdict(md);
  assert.equal(r.score, 4.1);
  assert.equal(r.summary, "Apply");
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

test("scoreTone bands match web/src/lib/format.ts's scoreTone", () => {
  assert.equal(scoreTone(4.5), "good");
  assert.equal(scoreTone(4.2), "good");
  assert.equal(scoreTone(4.0), "warn");
  assert.equal(scoreTone(3.8), "warn");
  assert.equal(scoreTone(3.5), "muted");
  assert.equal(scoreTone(3.0), "muted");
  assert.equal(scoreTone(2.9), "bad");
  assert.equal(scoreTone(null), "muted");
});
