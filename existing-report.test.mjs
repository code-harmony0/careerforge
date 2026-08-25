// Tests for findExistingReport() — the pre-flight that stops a second
// evaluation of a posting already evaluated.
//
// Run:  node --test existing-report.test.mjs
//
// The bug these exist for, measured on 2026-08-25:
//   16:54:05  reports/041-RESERVED.md      reservation taken
//   16:54:49  reports/041-huspy-…md        report written
//   17:02:13  reports/042-huspy-…md        byte-identical report, 8 min later
//
// The same posting was evaluated twice and each run took a fresh number. The
// tracker deduped correctly and kept ONE Huspy row — reports/ had no such
// guard, so the numbering grew a hole and row 41 ended up pointing at 042.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findExistingReport } from "./existing-report.mjs";

function scratch(reports = {}, tracker = "") {
  const root = mkdtempSync(join(tmpdir(), "existing-report-"));
  mkdirSync(join(root, "reports"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  for (const [name, body] of Object.entries(reports)) {
    writeFileSync(join(root, "reports", name), body);
  }
  writeFileSync(join(root, "data", "applications.md"), tracker);
  return root;
}

const HUSPY = `# Huspy — Mobile Engineer
**Score:** 4.7/5
**URL:** https://huspy.com/jobs/123?utm_source=linkedin
**Legitimacy:** verified
`;

test("no reports means nothing to find", () => {
  const root = scratch();
  try {
    assert.equal(findExistingReport({ root, url: "https://huspy.com/jobs/123" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds a prior report by posting URL", () => {
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY });
  try {
    const hit = findExistingReport({ root, url: "https://huspy.com/jobs/123" });
    assert.equal(hit?.num, "041");
    assert.equal(hit.matchedOn, "url");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracking params do not defeat the match — url-key.mjs owns that rule", () => {
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY });
  try {
    const hit = findExistingReport({ root, url: "https://HUSPY.com/jobs/123?utm_campaign=x&gclid=y" });
    assert.equal(hit?.num, "041");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuinely different posting at the same company is NOT a duplicate", () => {
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY });
  try {
    assert.equal(findExistingReport({ root, url: "https://huspy.com/jobs/999" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to company+role when no URL is available", () => {
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY });
  try {
    const hit = findExistingReport({ root, company: "Huspy", role: "Mobile Engineer" });
    assert.equal(hit?.num, "041");
    assert.equal(hit.matchedOn, "company+role");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different role at a matched company is not a duplicate", () => {
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY });
  try {
    assert.equal(findExistingReport({ root, company: "Huspy", role: "Backend Engineer" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESERVED sentinels are never mistaken for a real report", () => {
  // A sentinel is an in-flight reservation, not an evaluation. Treating one as
  // an existing report would block the very run that reserved it.
  const root = scratch({ "041-RESERVED.md": "reserved" });
  try {
    assert.equal(findExistingReport({ root, company: "Huspy", role: "Mobile Engineer" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a URL mismatch on both sides proves they are different postings", () => {
  // Same company and a fuzzily similar role, but each report names its own
  // distinct URL — that is positive evidence of two openings, not one.
  const other = HUSPY.replace("jobs/123", "jobs/456");
  const root = scratch({ "041-huspy-2026-08-25.md": HUSPY, "042-huspy-2026-08-25.md": other });
  try {
    const hit = findExistingReport({ root, url: "https://huspy.com/jobs/456" });
    assert.equal(hit?.num, "042");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
