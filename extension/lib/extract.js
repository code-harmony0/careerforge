// extension/lib/extract.js
// Pure, DOM-free helpers so they're unit-testable with node --test.
// NOTE: deliberately NOT an ES module (no `export`/`import`) — this file is
// loaded as a CLASSIC content script per manifest.json's content_scripts[].js
// array, and MV3 content scripts have no per-file "type": "module" option.
// Top-level `export` is a SyntaxError in that context and would silently
// break the capture pill. Instead we attach to `globalThis`, which resolves
// to the page's `window` in a browser content script and to Node's global
// object in the test runner — same file, same behavior, both environments.

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function capText(s, maxChars) {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

const JD_TEXT_CAP = 15000;

// DOM-dependent — not unit tested here, exercised manually in the browser.
function capturePage(doc) {
  doc = doc || document;
  const text = capText(collapseWhitespace((doc.body && doc.body.innerText) || ""), JD_TEXT_CAP);
  return { url: location.href, title: doc.title || "", text };
}

globalThis.careerOpsExtract = { collapseWhitespace, capText, capturePage };
