// extension/lib/verdict.js
export function parseVerdict(text) {
  const str = String(text ?? "");

  // 1. Explicit VERDICT line (plain or bold, e.g. VERDICT: 4.5/5, **VERDICT:** 4.5/5, **VERDICT: 4.5/5**)
  const vm = str.match(/(?:\*{0,2}VERDICT[:\s*]*)\s*([\d.]+)\s*\/\s*5(?:\*{0,2})\s*(?:[—:|-]+\s*(.+))?/i);
  if (vm) {
    const score = parseFloat(vm[1]);
    const summary = (vm[2] || "").trim().replace(/\s+/g, " ").slice(0, 140);
    return { score: Number.isNaN(score) ? null : score, summary };
  }

  // 2. Report header / lead structure
  const scoreMatch = str.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/i)
    || str.match(/^\s*score:\s*["']?([\d.]+)["']?/m)
    || str.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);

  const decisionLead = str.match(/^\*\*(?:Apply|Consider|Skip|Pass|Research first|Investigate)\.\*\*\s*(.+)$/m);
  const decisionHeader = str.match(/\*\*Decision:\*\*\s*(.+)$/m);
  const yamlDecision = str.match(/^\s*final_decision:\s*["']?([^"'\n]+)["']?/m);

  const summary = (decisionLead?.[1] || decisionHeader?.[1] || yamlDecision?.[1] || "")
    .trim().replace(/\s+/g, " ").slice(0, 140);

  if (scoreMatch) {
    const score = parseFloat(scoreMatch[1]);
    return {
      score: Number.isNaN(score) ? null : score,
      summary,
    };
  }

  return { score: null, summary: "" };
}

// Same bands as web/src/lib/format.ts's scoreTone(), so a score means the
// same color in the extension as it does in the web app.
export function scoreTone(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "muted";
  if (score >= 4.2) return "good";
  if (score >= 3.8) return "warn";
  if (score >= 3.0) return "muted";
  return "bad";
}
