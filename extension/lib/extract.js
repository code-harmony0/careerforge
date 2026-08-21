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
const MIN_DETAIL_TEXT_LEN = 200;

// Split-pane job boards (Indeed, LinkedIn, many ATS "list + detail" layouts)
// keep 20 other postings' text on the page alongside the one the user is
// actually looking at. Capturing document.body on those pages captures noise,
// not a job description. Try known detail-pane containers first, in priority
// order, and only fall back to the whole page when none match (or match but
// are too short to be a real posting — an empty pane before JS hydrates).
const DETAIL_PANE_SELECTORS = [
  "#jobsearch-ViewjobPaneWrapper", // Indeed inline preview pane
  ".jobsearch-JobComponent",
  '[data-testid="jobsearch-JobComponent"]',
  ".jobs-search__job-details--wrapper", // LinkedIn split view
  ".jobs-details",
  "article",
  "main",
];

// Exported separately (and given an injectable selector list) so the
// selection PRIORITY can be unit tested against a fake doc, without a real
// DOM — node:test has no DOM implementation available.
function pickDetailRoot(doc, selectors) {
  for (const sel of selectors || DETAIL_PANE_SELECTORS) {
    const el = doc.querySelector(sel);
    const text = el && el.innerText;
    if (text && collapseWhitespace(text).length >= MIN_DETAIL_TEXT_LEN) return el;
  }
  return doc.body;
}

// URL shapes that are almost always a LIST of postings (a search/results
// page), not one posting — evaluating them wastes a run on noise. Kept as a
// soft signal (the UI warns, never blocks) since this is inherently a guess.
const LISTING_URL_PATTERNS = [
  /\/jobs\/search\b/i,
  /\/search\/jobs\b/i,
  /\/jobs\/?\?/i, // e.g. indeed.com/jobs?q=..., linkedin.com/jobs?...
];
const SINGLE_POSTING_URL_PATTERNS = [
  /\/viewjob\b/i, // indeed.com/viewjob?jk=...
  /\/jobs\/view\//i, // linkedin.com/jobs/view/12345
  /\/job\//i,
];

function looksLikeListingUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const target = u.pathname + u.search;
  if (SINGLE_POSTING_URL_PATTERNS.some((re) => re.test(target))) return false;
  return LISTING_URL_PATTERNS.some((re) => re.test(target));
}

// DOM-dependent — not unit tested here, exercised manually in the browser.
function capturePage(doc) {
  doc = doc || document;
  const root = pickDetailRoot(doc, DETAIL_PANE_SELECTORS);
  const text = capText(collapseWhitespace((root && root.innerText) || ""), JD_TEXT_CAP);
  return { url: location.href, title: doc.title || "", text, isListingUrl: looksLikeListingUrl(location.href) };
}

globalThis.careerOpsExtract = { collapseWhitespace, capText, capturePage, pickDetailRoot, looksLikeListingUrl };
