// extension/lib/envelopes.js

function codeRanges(s) {
  const ranges = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(s))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
function inRanges(i, ranges) {
  return ranges.some(([a, b]) => i >= a && i < b);
}

// Mirrors web/src/components/assistant-console.tsx's parseEnvelopes for the
// COMPLETE-envelope case (the side panel redraws the whole message on every
// chunk, so it doesn't need that file's partial-hiding bookkeeping).
export function parseEnvelopes(acc) {
  const ranges = codeRanges(acc);
  const complete = [];
  const open = /<<act:([a-zA-Z]+)[ \t]+/g;
  let m;
  while ((m = open.exec(acc))) {
    const start = m.index;
    if (inRanges(start, ranges)) continue;
    const argsStart = m.index + m[0].length;
    const close = acc.indexOf(">>", argsStart);
    if (close === -1) continue;
    complete.push({ start, end: close + 2, id: m[1], argsJson: acc.slice(argsStart, close).trim() });
  }
  return { complete };
}

export function stripEnvelopes(text, envelopes) {
  if (!envelopes.length) return text;
  let out = "";
  let pos = 0;
  for (const { start, end } of [...envelopes].sort((a, b) => a.start - b.start)) {
    if (start > pos) out += text.slice(pos, start);
    pos = Math.max(pos, end);
  }
  return out + text.slice(pos);
}

// "evaluate" is handled NATIVELY in sidepanel.js (same /api/run call the web
// app makes). Every other action opens/focuses a real career-ops tab so the
// existing web app UI finishes the job — see the implementation plan's
// "Deviation from the design doc" note for why.
const ROUTES = {
  navigate: (a) => a.path || "/",
  filterPipeline: (a) => `/pipeline?tab=${a.tab || "ALL"}&min=${a.min ?? 0}${a.q ? `&q=${encodeURIComponent(a.q)}` : ""}`,
  evaluateCompany: (a) => `/pipeline?tab=INBOX${a.company ? `&q=${encodeURIComponent(a.company)}` : ""}`,
  research: () => "/",
  generatePdf: (a) => (a.n ? `/pipeline/${a.n}` : "/pipeline"),
  setStatus: (a) => (a.n ? `/pipeline/${a.n}` : "/pipeline"),
  apply: (a) => `/apply${a.url ? `?url=${encodeURIComponent(a.url)}` : ""}`,
  setApplyField: () => "/apply",
  remember: () => "/",
  setProfile: () => "/config",
  setPortals: () => "/portals",
};

export function actionToPath(id, args) {
  const fn = ROUTES[id];
  return fn ? fn(args || {}) : "/";
}
