/**
 * lib/question-bank.mjs — parsing and serializing `interview-prep/question-bank.md`.
 *
 * Pure string logic, no fs, so `node --test` can drive it directly and so the
 * web read path can mirror it without importing across the Turbopack root
 * boundary (same split tracker-table.mjs uses against tracker-parse.mjs).
 *
 * WHY A TABLE AND NOT JSON. Every mode file already treats
 * `interview-prep/question-bank.md` as a markdown document a human reads and
 * hand-edits, and `data/applications.md` proves the pattern works: readable,
 * diffable, and still machine-parseable. Switching to JSON would break the four
 * modes that reference it by name.
 *
 * WHY HEADER-DRIVEN. Columns are resolved by NAME from the header row, never by
 * position. That is what makes a second parser in web/ safe: neither side
 * hardcodes an order, so neither can drift from the other when a column is
 * added. A file whose header is missing or unrecognized parses to zero rows
 * rather than silently mapping the wrong column onto `status`.
 */

/** Canonical column order for files this module writes. Readers do not rely on it. */
export const COLUMNS = ["ID", "Question", "Axis", "Tag", "Round", "Source", "Status", "Asked", "Last"];

/**
 * The three axes a question can belong to, plus behavioural.
 *
 * The split is the point of the whole file. A `tech` question is reusable
 * across every company using that stack, a `role` question across every role at
 * that level, and only `company` has to be regenerated per employer. Flattening
 * them (which is what a per-company prep brief does) is what made every company
 * pay to rediscover the same React Native question.
 */
export const AXES = ["tech", "role", "company", "behavioural"];

/** Interview audience, matching the vocabulary modes/interview-prep.md already emits. */
export const ROUNDS = ["recruiter-screen", "hiring-manager", "peer-tech", "panel-mixed", "any"];

/**
 * Practice status. The emoji vocabulary is NOT a decoration: modes/interview/
 * debrief.md Step 3 already specifies ✅ / 🟡 / 🔴 for this exact file, so
 * changing it would desync the mode from the artifact it writes.
 */
export const STATUSES = ["new", "🔴", "🟡", "✅"];

/** A cell's pipes and newlines have to survive a markdown table round-trip. */
function escapeCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function unescapeCell(value) {
  return String(value ?? "")
    .replace(/\\\|/g, "|")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * Split one table row into cells, honouring `\|` escapes.
 *
 * A plain `.split("|")` breaks any question containing a pipe, and interview
 * questions genuinely do ("explain `a || b` vs `a ?? b`").
 */
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

/** A `| --- | --- |` separator, in any of its alignment spellings. */
function isSeparator(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

/**
 * Parse a question bank into rows.
 *
 * Tolerant on purpose. This file is user-layer, gitignored, and hand-editable,
 * so one malformed row must not take out the whole bank: a row with the wrong
 * cell count is skipped, and its index is reported in `skipped` so a caller can
 * say so out loud instead of silently losing a question.
 *
 * @param {string} markdown
 * @returns {{questions: object[], skipped: number[], header: string[]}}
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
      // Require the two columns everything else is keyed off. Anything else
      // that happens to be a table (a prose example, a legend) is not the bank.
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

  return { questions, skipped, header: header ?? [] };
}

/**
 * Render rows back to a full bank file.
 *
 * @param {object[]} questions
 * @param {{title?: string, note?: string}} [opts]
 * @returns {string}
 */
export function serializeQuestionBank(questions, opts = {}) {
  const title = opts.title ?? "Question Bank";
  const note =
    opts.note ??
    "Written by `question-bank.mjs`. Safe to read and hand-edit, but prefer the script:\n" +
      "it takes the lock and writes atomically, so a concurrent run cannot half-write this file.";
  const head = `| ${COLUMNS.join(" | ")} |`;
  const sep = `|${COLUMNS.map(() => "---").join("|")}|`;
  const rows = questions.map((q) =>
    `| ${COLUMNS.map((c) => escapeCell(q[c.toLowerCase()] ?? "")).join(" | ")} |`,
  );
  return `# ${title}\n\n${note}\n\n${head}\n${sep}\n${rows.join("\n")}\n`;
}

/**
 * Next free `qNNN` id for a set of existing rows.
 *
 * Max-plus-one over the numeric suffix, never `length + 1`: deleting a row must
 * not make the next id collide with one already in use.
 *
 * @param {object[]} questions
 * @returns {string}
 */
export function nextId(questions) {
  let max = 0;
  for (const q of questions) {
    const m = /^q(\d+)$/i.exec(String(q.id ?? "").trim());
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `q${String(max + 1).padStart(3, "0")}`;
}

/**
 * Normalized key for duplicate detection.
 *
 * Case, punctuation and whitespace are dropped because the same question
 * arrives spelled differently from a prep brief, a pack and a debrief
 * ("Explain the bridge vs JSI" / "explain the bridge vs. JSI?"). Without this
 * the bank fills with near-identical rows and the dedup every mode file
 * promises is worthless.
 *
 * @param {string} question
 * @returns {string}
 */
export function questionKey(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Which questions are due for practice, hardest-first.
 *
 * No spaced-repetition library and no scheduling table: a due date is a
 * subtraction, and every question already carries the two fields needed for it.
 * Order is 🔴 first (you got these wrong), then 🟡 gone stale, then `new`.
 * Within a tier, questions asked in more real interviews come first — a question
 * three companies asked is not one to leave red.
 *
 * @param {object[]} questions
 * @param {{today?: string, staleDays?: number}} [opts]
 * @returns {object[]}
 */
export function dueQuestions(questions, opts = {}) {
  const today = opts.today ? new Date(opts.today) : new Date();
  const staleDays = opts.staleDays ?? 14;
  const ageDays = (last) => {
    if (!last || last === "—" || last === "-") return Infinity;
    const t = Date.parse(last);
    if (Number.isNaN(t)) return Infinity;
    return (today.getTime() - t) / 86_400_000;
  };
  const tier = (q) => {
    if (q.status === "🔴") return 0;
    if (q.status === "🟡" && ageDays(q.last) >= staleDays) return 1;
    if (!q.status || q.status === "new") return 2;
    return 3; // ✅, or 🟡 still fresh — not due
  };
  return questions
    .map((q) => ({ q, t: tier(q) }))
    .filter((x) => x.t < 3)
    .sort((a, b) => a.t - b.t || (b.q.asked ?? 0) - (a.q.asked ?? 0) || String(a.q.id).localeCompare(String(b.q.id)))
    .map((x) => x.q);
}
