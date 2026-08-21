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
