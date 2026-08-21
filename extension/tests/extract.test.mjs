// extension/tests/extract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import "../lib/extract.js";

const { collapseWhitespace, capText, pickDetailRoot, looksLikeListingUrl } = globalThis.careerOpsExtract;

// Minimal fake "doc" — just enough surface for pickDetailRoot's querySelector
// + innerText reads. No real DOM available under node:test.
function fakeDoc(matches, bodyText) {
  return {
    body: { innerText: bodyText },
    querySelector(sel) {
      return Object.prototype.hasOwnProperty.call(matches, sel) ? matches[sel] : null;
    },
  };
}

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

test("pickDetailRoot returns the first matching selector with enough real text", () => {
  const longEnough = "x".repeat(250);
  const doc = fakeDoc({ "#jobsearch-ViewjobPaneWrapper": { innerText: longEnough } }, "body fallback");
  const root = pickDetailRoot(doc, ["#jobsearch-ViewjobPaneWrapper", "main"]);
  assert.equal(root.innerText, longEnough);
});

test("pickDetailRoot skips a matching selector whose element is too short (not hydrated yet)", () => {
  const doc = fakeDoc(
    { "#jobsearch-ViewjobPaneWrapper": { innerText: "short" }, main: { innerText: "y".repeat(250) } },
    "body fallback",
  );
  const root = pickDetailRoot(doc, ["#jobsearch-ViewjobPaneWrapper", "main"]);
  assert.equal(root.innerText, "y".repeat(250));
});

test("pickDetailRoot falls back to document.body when nothing matches", () => {
  const doc = fakeDoc({}, "body fallback");
  const root = pickDetailRoot(doc, ["#jobsearch-ViewjobPaneWrapper", "main"]);
  assert.equal(root.innerText, "body fallback");
});

test("looksLikeListingUrl flags an Indeed search page", () => {
  assert.equal(looksLikeListingUrl("https://in.indeed.com/jobs?q=&l=Remote"), true);
});

test("looksLikeListingUrl does not flag an Indeed single posting", () => {
  assert.equal(looksLikeListingUrl("https://in.indeed.com/viewjob?jk=abc123"), false);
});

test("looksLikeListingUrl does not flag a LinkedIn single posting", () => {
  assert.equal(looksLikeListingUrl("https://www.linkedin.com/jobs/view/1234567890"), false);
});

test("looksLikeListingUrl flags a LinkedIn search page", () => {
  assert.equal(looksLikeListingUrl("https://www.linkedin.com/jobs/search/?keywords=react"), true);
});

test("looksLikeListingUrl does not flag an unrelated URL", () => {
  assert.equal(looksLikeListingUrl("https://example.com/about"), false);
});
