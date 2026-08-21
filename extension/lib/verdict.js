// extension/lib/verdict.js
export function parseVerdict(text) {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    return { score: parseFloat(m[1]), summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) return { score: parseFloat(s[1]), summary: "" };
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
