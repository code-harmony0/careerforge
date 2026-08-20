// web/tests/lib/interview-paths.test.mjs
//
// Pure logic for where a saved interview-prep artifact goes and how it merges
// with an existing file. Run: node --test tests/lib/interview-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInterviewPrepPath, mergeSection, SECTION_HEADINGS } from "../../src/lib/interview-paths.mjs";

test("resolveInterviewPrepPath: builds interview-prep/{company}-{role}.md", () => {
  const p = resolveInterviewPrepPath("/root", "Acme Corp", "Staff Engineer");
  assert.equal(p, "/root/interview-prep/acme-corp-staff-engineer.md");
});

test("resolveInterviewPrepPath: slugifies unsafe characters out of company/role", () => {
  // Given input that could otherwise escape interview-prep/ via path traversal
  const p = resolveInterviewPrepPath("/root", "../../etc", "passwd");
  // Then the slug strips everything but [a-z0-9-], so no ".." segment survives
  assert.equal(p, "/root/interview-prep/etc-passwd.md");
  assert.ok(!p.includes(".."));
});

test("resolveInterviewPrepPath: rejects empty company or role", () => {
  assert.equal(resolveInterviewPrepPath("/root", "", "Staff Engineer"), null);
  assert.equal(resolveInterviewPrepPath("/root", "Acme", "   "), null);
});

test("mergeSection: creates a fresh file with a title header when none exists", () => {
  const out = mergeSection(null, "interview-prep", "Acme Corp", "Staff Engineer", "Body text here.");
  assert.match(out, /^# Interview Prep — Acme Corp — Staff Engineer/);
  assert.match(out, /## Prep Brief/);
  assert.match(out, /Body text here\./);
});

test("mergeSection: appends a new section to an existing file", () => {
  const existing = "# Interview Prep — Acme Corp — Staff Engineer\n\n## Prep Brief\n\nOld content.\n";
  const out = mergeSection(existing, "interview-plan", "Acme Corp", "Staff Engineer", "Plan body.");
  assert.match(out, /## Prep Brief/);
  assert.match(out, /Old content\./);
  assert.match(out, /## Prep Plan/);
  assert.match(out, /Plan body\./);
});

test("mergeSection: replaces a section of the same kind instead of duplicating it", () => {
  const existing = "# Interview Prep — Acme Corp — Staff Engineer\n\n## Prep Brief\n\nStale content.\n";
  const out = mergeSection(existing, "interview-prep", "Acme Corp", "Staff Engineer", "Fresh content.");
  const mentions = out.match(/## Prep Brief/g) ?? [];
  assert.equal(mentions.length, 1, "must not duplicate the section heading");
  assert.ok(!out.includes("Stale content."));
  assert.match(out, /Fresh content\./);
});

test("mergeSection: does not accumulate blank lines across repeated merges on a multi-section file", () => {
  const existing =
    "# Interview Prep — Acme Corp — Staff Engineer\n\n" +
    "## Prep Brief\n\nBrief content.\n\n" +
    "## Prep Plan\n\nPlan content.\n\n" +
    "## Negotiation\n\nNegotiation content.\n";
  const first = mergeSection(existing, "interview-plan", "Acme Corp", "Staff Engineer", "Updated plan.");
  const second = mergeSection(first, "interview-plan", "Acme Corp", "Staff Engineer", "Updated plan again.");
  assert.ok(!/\n{3,}/.test(second), "must not grow blank lines between sections on repeated merges");
  assert.match(second, /## Prep Brief/);
  assert.match(second, /Brief content\./);
  assert.match(second, /## Negotiation/);
  assert.match(second, /Negotiation content\./);
  assert.match(second, /Updated plan again\./);
  assert.ok(!second.includes("Updated plan.\n"), "must not still contain the first merge's stale body");
});

test("SECTION_HEADINGS: covers all three savable kinds", () => {
  assert.equal(SECTION_HEADINGS["interview-prep"], "Prep Brief");
  assert.equal(SECTION_HEADINGS["interview-plan"], "Prep Plan");
  assert.equal(SECTION_HEADINGS["offer-prep"], "Negotiation");
});
