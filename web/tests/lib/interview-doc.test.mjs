// web/tests/lib/interview-doc.test.mjs
//
// What is left of our own document logic after rehype-slug took over slugging,
// duplicate-id disambiguation and anchor generation: the mode files' Step-N
// authoring scaffold, and reading back our own saved-file format.
// Run: node --test tests/lib/interview-doc.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanInterviewHeading,
  remarkCleanInterviewHeadings,
  parseSavedBrief,
  documentTeaser,
} from "../../src/lib/interview-doc.mjs";

test("cleanInterviewHeading: strips the mode file's Step-N authoring scaffold", () => {
  assert.equal(cleanInterviewHeading("Step 4 — Likely Questions"), "Likely Questions");
  assert.equal(cleanInterviewHeading("Step 2.5 — Audience Map"), "Audience Map");
  assert.equal(cleanInterviewHeading("Step 1: Research"), "Research");
});

test("cleanInterviewHeading: keeps a heading that only LOOKS like scaffold", () => {
  // No title follows, so stripping would leave nothing to click in the rail.
  assert.equal(cleanInterviewHeading("Step 3"), "Step 3");
  // Not the scaffold grammar — a real section that happens to start with "Step".
  assert.equal(cleanInterviewHeading("Steps To Reproduce"), "Steps To Reproduce");
  assert.equal(cleanInterviewHeading("Step by step walkthrough"), "Step by step walkthrough");
});

test("parseSavedBrief: reads back exactly what mergeSection writes", () => {
  const saved = "# Interview Prep — Acme Corp — Staff Engineer\n\n## Prep Brief\n\nbrief body\n\n## Prep Plan\n\nplan body\n";
  const doc = parseSavedBrief(saved);
  assert.equal(doc.company, "Acme Corp");
  assert.equal(doc.role, "Staff Engineer");
  assert.deepEqual(doc.sections, [
    { heading: "Prep Brief", body: "brief body" },
    { heading: "Prep Plan", body: "plan body" },
  ]);
});

test("parseSavedBrief: a role containing an em-dash stays whole", () => {
  const doc = parseSavedBrief("# Interview Prep — Qrusible — Senior Engineer — React Native\n\n## Prep Brief\n\nx\n");
  assert.equal(doc.company, "Qrusible");
  assert.equal(doc.role, "Senior Engineer — React Native");
});

test("parseSavedBrief: hand-edited file with no recognizable title degrades, never throws", () => {
  // These files are user-layer and editable by hand; one drifted file must not
  // take out the whole library listing.
  const doc = parseSavedBrief("some notes I pasted\n\n## Prep Brief\n\nbody\n");
  assert.equal(doc.company, "");
  assert.equal(doc.role, "");
  assert.deepEqual(doc.sections, [{ heading: "Prep Brief", body: "body" }]);
  assert.doesNotThrow(() => parseSavedBrief(""));
});

test("documentTeaser: skips headings, fences and table rows", () => {
  const md = "## Heading\n\n| a | b |\n| --- | --- |\n\nThe first real sentence. And a second.";
  assert.equal(documentTeaser(md), "The first real sentence. And a second.");
});

test("documentTeaser: truncates with an ellipsis, never mid-nothing", () => {
  const teaser = documentTeaser("x".repeat(500), 20);
  assert.equal(teaser.length, 20);
  assert.ok(teaser.endsWith("…"));
  assert.equal(documentTeaser("## only a heading"), "");
});


// The plugin is tested against a hand-built mdast node rather than by booting a
// unified pipeline: slugging, duplicate ids and anchor generation now belong to
// rehype-slug and github-slugger, which have their own test suites. What is
// ours is exactly this — the scaffold is removed from the AST BEFORE rehype-slug
// runs, which is what makes the anchor "#likely-questions" instead of
// "#step-4--likely-questions".
function headingNode(children) {
  return { type: "root", children: [{ type: "heading", depth: 2, children }] };
}

test("remarkCleanInterviewHeadings: strips the scaffold from the heading's text node", () => {
  const tree = headingNode([{ type: "text", value: "Step 4 — Likely Questions" }]);
  remarkCleanInterviewHeadings()(tree);
  assert.equal(tree.children[0].children[0].value, "Likely Questions");
});

test("remarkCleanInterviewHeadings: leaves a heading whose first child isn't plain text", () => {
  // Rewriting deeper nodes would corrupt the inline formatting.
  const tree = headingNode([
    { type: "strong", children: [{ type: "text", value: "Step 4 — Bold" }] },
    { type: "text", value: " tail" },
  ]);
  remarkCleanInterviewHeadings()(tree);
  assert.equal(tree.children[0].children[0].children[0].value, "Step 4 — Bold");
});

test("remarkCleanInterviewHeadings: survives a heading with no children", () => {
  const tree = headingNode([]);
  assert.doesNotThrow(() => remarkCleanInterviewHeadings()(tree));
});

test("documentTeaser: strips leading list markers and quote carets, not mid-word hyphens", () => {
  assert.equal(documentTeaser("- Rounds: 3–4 stages\n- Format: screen"), "Rounds: 3–4 stages Format: screen");
  assert.equal(documentTeaser("1. first\n2. second"), "first second");
  assert.equal(documentTeaser("> quoted line"), "quoted line");
  assert.equal(documentTeaser("a well-known trade-off"), "a well-known trade-off");
});
