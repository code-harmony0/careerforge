// Tests for applyCvDecisions() — the per-item add/drop resolution that runs
// between "the agent produced a CV" and "a PDF exists".
//
// Run:  node --test tests/lib/cv-decisions.test.mjs
//
// Why this is code and not a mode instruction: modes/pdf.md step 14a tells the
// agent to stop and ask, which works when a human is in the conversation. Web
// and extension runs are headless — spawnHeadlessCli gives the agent no channel
// to receive an answer on — so there the run must stop BEFORE rendering, hand
// the findings to the UI, and resume once decisions come back.
//
// Dropping does not need a second agent pass: the backend already holds the
// generated HTML, and removing a competency tag from it is a deterministic
// edit. That is what keeps this feature small.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCvDecisions } from "../../src/lib/cv-decisions.mjs";

const HTML = `<section class="competencies">
  <span class="competency-tag">React Native &amp; Mobile Architecture</span>
  <span class="competency-tag">SOLID Engineering Principles</span>
  <span class="competency-tag">PropTech &amp; Marketplace Super Apps</span>
</section>`;

test("dropping removes exactly that tag and leaves the rest", () => {
  const r = applyCvDecisions(HTML, [{ tag: "SOLID Engineering Principles", action: "drop" }]);
  assert.ok(!r.html.includes("SOLID"));
  assert.ok(r.html.includes("React Native"));
  assert.ok(r.html.includes("PropTech"));
});

test("mixed decisions are honoured per item — the whole point", () => {
  const r = applyCvDecisions(HTML, [
    { tag: "SOLID Engineering Principles", action: "drop" },
    { tag: "PropTech &amp; Marketplace Super Apps", action: "add" },
  ]);
  assert.ok(!r.html.includes("SOLID"), "dropped tag must be gone");
  assert.ok(r.html.includes("PropTech"), "added tag stays on the CV");
  assert.deepEqual(r.toAdd, ["PropTech & Marketplace Super Apps"]);
});

test("an added tag is reported for cv.md, decoded, not left as entities", () => {
  const r = applyCvDecisions(HTML, [{ tag: "React Native &amp; Mobile Architecture", action: "add" }]);
  assert.deepEqual(r.toAdd, ["React Native & Mobile Architecture"]);
});

test("matching tolerates entity vs literal spelling of the same tag", () => {
  // The UI shows the decoded tag; the HTML holds the entity form. A decision
  // coming back as "React Native & Mobile Architecture" must still match.
  const r = applyCvDecisions(HTML, [{ tag: "React Native & Mobile Architecture", action: "drop" }]);
  assert.ok(!r.html.includes("React Native"));
});

test("no decisions leaves the document byte-identical", () => {
  const r = applyCvDecisions(HTML, []);
  assert.equal(r.html, HTML);
  assert.deepEqual(r.toAdd, []);
});

test("an unknown tag is ignored rather than corrupting the document", () => {
  const r = applyCvDecisions(HTML, [{ tag: "Nothing Like This", action: "drop" }]);
  assert.equal(r.html, HTML);
});

test("an unrecognized action is treated as drop — fail closed", () => {
  // A malformed decision must not silently KEEP an unsupported claim: the
  // safe default when intent is unclear is to leave it off the CV.
  const r = applyCvDecisions(HTML, [{ tag: "SOLID Engineering Principles", action: "???" }]);
  assert.ok(!r.html.includes("SOLID"));
  assert.deepEqual(r.toAdd, []);
});

test("dropping every tag empties the grid without breaking the markup", () => {
  const r = applyCvDecisions(HTML, [
    { tag: "React Native &amp; Mobile Architecture", action: "drop" },
    { tag: "SOLID Engineering Principles", action: "drop" },
    { tag: "PropTech &amp; Marketplace Super Apps", action: "drop" },
  ]);
  assert.ok(!/competency-tag/.test(r.html));
  assert.ok(r.html.includes("</section>"), "surrounding markup survives");
});

test("a tag containing regex metacharacters is matched literally", () => {
  const html = `<span class="competency-tag">C++ (advanced)</span>`;
  const r = applyCvDecisions(html, [{ tag: "C++ (advanced)", action: "drop" }]);
  assert.ok(!r.html.includes("C++"));
});
