// web/src/lib/interview-doc.mjs
//
// The two things about an interview brief that are genuinely OURS, and nothing
// more.
//
// An earlier draft of this file hand-rolled heading slugging, duplicate-id
// disambiguation and document splitting — roughly 150 lines reimplementing
// what `rehype-slug` (3.3M downloads/week, on `github-slugger`) already does
// correctly, unicode edge cases included. That is now a plugin in the
// react-markdown pipeline, and the rail reads the ids off the rendered
// headings. What is left here is the part no library can know:
//
//   1. The mode files number their own instructions ("Step 4 — Likely
//      Questions"). That is authoring scaffold, not a section name.
//   2. interview-paths.mjs's mergeSection defines our saved-file format, so
//      reading one back is ours to write.
//
// Plain .mjs (same as report-sections.mjs / interview-paths.mjs) so
// tests/lib/interview-doc.test.mjs can import it under node:test.
import { visit } from "unist-util-visit";

/**
 * Authoring scaffold the mode files number their own instructions with. The
 * user asked for a prep brief, not a transcript of the procedure that produced
 * it — "Step 4 — Likely Questions" is "Likely Questions" to a reader.
 *
 * Only stripped when a real title follows: a bare "## Step 3" keeps its number,
 * because dropping it would leave an empty heading.
 */
const STEP_PREFIX = /^\s*Step\s+[\d.]+\s*(?:[—–:-]+\s*)(?=\S)/i;

/**
 * Strip the authoring scaffold from a heading for display.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanInterviewHeading(text) {
  return String(text ?? "").replace(STEP_PREFIX, "").trim();
}

/**
 * remark plugin: rewrite heading text in the AST before rehype-slug sees it,
 * so the scaffold is gone from BOTH the rendered heading and the generated id
 * (`#likely-questions`, not `#step-4--likely-questions`).
 *
 * Only the first text node of a heading is touched — the prefix can only ever
 * be at the start, and rewriting deeper nodes would corrupt inline formatting.
 *
 * @returns {(tree: import("unist").Node) => void}
 */
export function remarkCleanInterviewHeadings() {
  return (tree) => {
    visit(tree, "heading", (node) => {
      const first = node.children?.[0];
      if (first?.type !== "text") return;
      first.value = cleanInterviewHeading(first.value);
    });
  };
}

/**
 * Split a SAVED interview-prep/{slug}.md into its top-level sections.
 *
 * The save route writes "# Interview Prep — {Company} — {Role}" followed by
 * "## Prep Brief" / "## Prep Plan" sections (see interview-paths.mjs's
 * mergeSection, which is the only writer). Reading it back needs the inverse.
 *
 * Tolerant by design — these files are user-layer and hand-editable, so a file
 * that has drifted from the exact shape mergeSection writes still returns
 * whatever could be recovered rather than failing the whole library listing.
 *
 * @param {string} markdown
 * @returns {{title: string, company: string, role: string, sections: {heading: string, body: string}[]}}
 */
export function parseSavedBrief(markdown) {
  const text = String(markdown ?? "").trim();
  const [head, ...rest] = text.split(/\n(?=## )/);
  const titleLine = /^#\s+(.+)$/m.exec(head ?? "");
  const title = titleLine ? titleLine[1].trim() : "";
  // "Interview Prep — {Company} — {Role}". Split on the em-dash the writer
  // uses; a title that doesn't match leaves company/role blank rather than
  // guessing, and the caller falls back to the filename slug.
  const parts = title.split(/\s+—\s+/);
  const company = parts.length >= 3 ? parts[1].trim() : "";
  const role = parts.length >= 3 ? parts.slice(2).join(" — ").trim() : "";
  const sections = rest.map((chunk) => {
    const nl = chunk.indexOf("\n");
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).replace(/^##\s*/, "").trim();
    const body = nl === -1 ? "" : chunk.slice(nl + 1).trim();
    return { heading, body };
  });
  return { title, company, role, sections };
}

/**
 * First readable sentence of a document, for a library card's teaser.
 * Strips headings, fences, tables and markdown punctuation — a teaser made of
 * "| --- | --- |" is worse than no teaser.
 *
 * @param {string} markdown
 * @param {number} [max=160]
 * @returns {string}
 */
export function documentTeaser(markdown, max = 160) {
  const text = String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    // List markers and blockquote carets, at line start only — a hyphen mid
    // sentence is a hyphen. Without this the teaser opened on a bare "- ",
    // which reads as a rendering bug rather than a summary.
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/[*_`#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
