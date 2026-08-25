// Tests for the preview cache: paths, name safety, and staleness.
//
// Run:  node --test tests/lib/cv-previews.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  previewDir,
  previewPath,
  thumbPath,
  isSafeTemplateName,
  cvHash,
  readManifest,
  writeManifest,
  previewState,
} from "../../src/lib/cv-previews.mjs";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "cv-previews-"));
  mkdirSync(previewDir(root), { recursive: true });
  return root;
}

/** A complete preview is BOTH artifacts — the grid needs the PNG, the link the PDF. */
function writeBoth(root, name) {
  writeFileSync(previewPath(root, name), "%PDF-1.4");
  writeFileSync(thumbPath(root, name), "\x89PNG");
}

test("previews live under .career-ops-web, never output/", () => {
  const dir = previewDir("/tmp/root");
  assert.match(dir, /\.career-ops-web/);
  assert.doesNotMatch(dir, /output/);
});

test("isSafeTemplateName accepts real template names", () => {
  for (const n of ["standard", "modern", "zh-minimal", "jake"]) {
    assert.equal(isSafeTemplateName(n), true, n);
  }
});

test("isSafeTemplateName rejects traversal and separators", () => {
  for (const n of ["../../etc/passwd", "a/b", "a\\b", "..", "", "Modern", "a".repeat(65)]) {
    assert.equal(isSafeTemplateName(n), false, JSON.stringify(n));
  }
});

test("previewPath throws rather than building a traversal path", () => {
  assert.throws(() => previewPath("/tmp/root", "../../etc/passwd"), /unsafe template name/);
});

test("cvHash is content-based, so a no-op Save does not invalidate previews", () => {
  assert.equal(cvHash("# CV"), cvHash("# CV"));
  assert.notEqual(cvHash("# CV"), cvHash("# CV "));
});

test("readManifest on a missing file is empty, not a throw", () => {
  const root = scratch();
  try {
    assert.deepEqual(readManifest(root), { cvHash: null, generatedAt: null, failed: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeManifest round-trips through readManifest", () => {
  const root = scratch();
  try {
    writeManifest(root, { cvHash: "abc", failed: ["jake"] });
    const m = readManifest(root);
    assert.equal(m.cvHash, "abc");
    assert.deepEqual(m.failed, ["jake"]);
    assert.ok(m.generatedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: missing when there is no PDF", () => {
  const root = scratch();
  try {
    assert.equal(previewState(root, "modern", "abc"), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: an empty PDF counts as missing, not ready", () => {
  const root = scratch();
  try {
    writeFileSync(previewPath(root, "modern"), "");
    writeManifest(root, { cvHash: "abc", failed: [] });
    assert.equal(previewState(root, "modern", "abc"), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: ready when the PDF exists and the CV hash matches", () => {
  const root = scratch();
  try {
    writeBoth(root, "modern");
    writeManifest(root, { cvHash: "abc", failed: [] });
    assert.equal(previewState(root, "modern", "abc"), "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: stale once cv.md changes — the PDF is still shown", () => {
  const root = scratch();
  try {
    writeBoth(root, "modern");
    writeManifest(root, { cvHash: "abc", failed: [] });
    assert.equal(previewState(root, "modern", "def"), "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: a recorded failure wins over a stale leftover PDF", () => {
  const root = scratch();
  try {
    writeBoth(root, "jake");
    writeManifest(root, { cvHash: "abc", failed: ["jake"] });
    assert.equal(previewState(root, "jake", "abc"), "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previewState: a PDF with no thumbnail is missing — the grid has nothing to show", () => {
  const root = scratch();
  try {
    writeFileSync(previewPath(root, "modern"), "%PDF-1.4");
    writeManifest(root, { cvHash: "abc", failed: [] });
    assert.equal(previewState(root, "modern", "abc"), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thumbPath refuses a traversal name the same way previewPath does", () => {
  assert.throws(() => thumbPath("/tmp/root", "../../etc/passwd"), /unsafe template name/);
});
