// Pure, DOM-free helpers so they're unit-testable with node --test.
// Loaded as a plain <script>/content-script (not a module) so it also works
// unbundled inside content-script.js — exported via `export` for the test
// runner AND attached to `self` for the content-script's non-module context.

export function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

export function capText(s, maxChars) {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

const JD_TEXT_CAP = 15000;

// DOM-dependent — not unit tested here, exercised manually in the browser.
export function capturePage(doc = document) {
  const text = capText(collapseWhitespace(doc.body?.innerText || ""), JD_TEXT_CAP);
  return { url: location.href, title: doc.title || "", text };
}

if (typeof self !== "undefined") {
  self.careerOpsExtract = { collapseWhitespace, capText, capturePage };
}
