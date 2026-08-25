#!/usr/bin/env node

// cv-decisions.mjs — resolve per-item add/drop decisions against a generated CV.
//
// modes/pdf.md step 14a makes the agent stop and ask before putting anything on
// the CV that cv.md does not support. That works when a human is in the
// conversation. Web and extension runs are HEADLESS — spawnHeadlessCli gives the
// agent no channel to receive an answer on — so there the run stops before
// rendering, hands the findings to the UI, and resumes once decisions come back.
//
// Dropping deliberately does NOT re-run the agent. The backend already holds the
// generated HTML, and removing a competency tag from it is a deterministic edit;
// a second tailoring pass would cost tokens, take minutes, and could return a
// different CV than the one the user just made decisions about.
//
// Pure and framework-free so both surfaces and `node --test` share one
// implementation of what "drop" means.

const TAG_RE = /<([a-z]+)[^>]*class="[^"]*\bcompetency-tag\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;

/** Decode the handful of entities build-cv-html.mjs's escapeHtml produces. */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Comparable form of a tag.
 *
 * The UI shows the DECODED tag ("React Native & Mobile Architecture") while the
 * HTML holds the entity form ("React Native &amp; Mobile Architecture"), so a
 * decision posted back from either surface has to match either spelling.
 */
function key(tag) {
  return decodeEntities(tag).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Apply per-item decisions to a generated CV.
 *
 * @param {string} html - The CV HTML the backend saved from the agent's envelope.
 * @param {Array<{tag: string, action: string}>} decisions
 * @returns {{html: string, toAdd: string[]}} The CV with dropped tags removed,
 *   and the decoded tags the user confirmed are real — for cv.md via add-entry.mjs.
 */
export function applyCvDecisions(html, decisions = []) {
  const source = String(html ?? '');
  if (!Array.isArray(decisions) || decisions.length === 0) return { html: source, toAdd: [] };

  // Anything decided but not spelled "add" is dropped. Fail closed on purpose:
  // a malformed or unrecognized action must never silently KEEP a claim the
  // user was asked about, because the whole point of asking was that it is not
  // supported by cv.md.
  const byKey = new Map();
  for (const d of decisions) {
    if (!d || typeof d.tag !== 'string') continue;
    byKey.set(key(d.tag), d.action === 'add' ? 'add' : 'drop');
  }

  const toAdd = [];
  const out = source.replace(TAG_RE, (match, _tagName, inner) => {
    const label = decodeEntities(inner).replace(/\s+/g, ' ').trim();
    const decision = byKey.get(key(label));
    // A tag nobody decided on was never in question — leave it exactly as it is
    // rather than treating silence as a verdict either way.
    if (!decision) return match;
    if (decision === 'add') {
      toAdd.push(label);
      return match;
    }
    return '';
  });

  // Collapse the whitespace a removed tag leaves behind, so dropping every tag
  // does not leave a run of blank lines inside the grid.
  return { html: out.replace(/[ \t]*\n(?:[ \t]*\n)+/g, '\n'), toAdd };
}

export default applyCvDecisions;
