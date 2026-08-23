/**
 * question-bank-read.mjs — the web's READ path for interview-prep/question-bank.md.
 *
 * A deliberate mirror of lib/question-bank.mjs at the career-ops root, the same
 * way tracker-table.mjs mirrors tracker-parse.mjs: web/ pins its Turbopack root
 * to itself, so importing across that boundary is fragile in a way a small
 * duplicated parser is not.
 *
 * Drift is prevented structurally rather than by discipline: BOTH parsers
 * resolve columns by NAME from the header row and neither hardcodes an order,
 * so a column added on one side is simply ignored by the other instead of
 * silently shifting `status` onto the wrong cell.
 *
 * Read-only on purpose. Every write goes through `node question-bank.mjs`,
 * which holds the lock — the same delegation /api/status makes to
 * set-status.mjs, and for the same reason (#2900): atomic file replacement is
 * not atomicity around the read-modify-write.
 */

function unescapeCell(value) {
  return String(value ?? "").replace(/\\\|/g, "|").replace(/\\\\/g, "\\").trim();
}

function splitRow(line) {
  const cells = [];
  let cur = "";
  let escaped = false;
  for (const ch of line.trim().replace(/^\||\|$/g, "")) {
    if (escaped) {
      cur += "\\" + ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (escaped) cur += "\\";
  cells.push(cur);
  return cells.map(unescapeCell);
}

function isSeparator(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

/**
 * @param {string} markdown
 * @returns {{questions: object[], skipped: number[]}}
 */
export function parseQuestionBank(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const questions = [];
  const skipped = [];
  let header = null;
  let headerIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    if (header === null) {
      const cells = splitRow(line);
      const lower = cells.map((c) => c.toLowerCase());
      if (!lower.includes("id") || !lower.includes("question")) continue;
      header = cells;
      headerIndex = i;
      continue;
    }
    if (i === headerIndex + 1 && isSeparator(line)) continue;
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      skipped.push(i + 1);
      continue;
    }
    const row = {};
    header.forEach((name, k) => {
      row[name.toLowerCase()] = cells[k];
    });
    if (!row.id) {
      skipped.push(i + 1);
      continue;
    }
    row.asked = Number.parseInt(row.asked, 10) || 0;
    questions.push(row);
  }
  return { questions, skipped };
}

/** Facet counts for the filter chips, computed in one pass over the rows. */
export function facets(questions) {
  const count = (key) => {
    const m = new Map();
    for (const q of questions) {
      const v = String(q[key] ?? "").trim();
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, count: n }));
  };
  return { axis: count("axis"), tag: count("tag"), status: count("status"), round: count("round") };
}
