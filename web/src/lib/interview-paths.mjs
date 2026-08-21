// web/src/lib/interview-paths.mjs
//
// Where a saved interview-prep/plan artifact goes, and how it merges
// with a file that already exists. Kept plain (no fs, no Next.js) so it can be
// unit-tested directly — same split as pdf-paths.mjs. The route that calls this
// owns fs.readFileSync/writeFileSync; this module only computes strings.
import path from "node:path";
import { slugify } from "./pdf-paths.mjs";

/** Section heading per savable kind — also the merge key mergeSection matches on. */
export const SECTION_HEADINGS = {
  "interview-prep": "Prep Brief",
  "interview-plan": "Prep Plan",
};

/**
 * Where a saved artifact for this company/role lives. slugify() strips
 * everything but [a-z0-9-], so a crafted company/role string (e.g. "../../etc")
 * cannot escape interview-prep/ — same defense pdf-paths.mjs's resolvePdfPaths
 * relies on for the report-number selector.
 *
 * @param {string} root - careerOpsRoot().
 * @param {string} company
 * @param {string} role
 * @returns {string | null} absolute path, or null if company/role slugify to empty.
 */
export function resolveInterviewPrepPath(root, company, role) {
  const companySlug = slugify(String(company ?? ""));
  const roleSlug = slugify(String(role ?? ""));
  if (!companySlug || !roleSlug) return null;
  return path.join(root, "interview-prep", `${companySlug}-${roleSlug}.md`);
}

/**
 * Merge a new section into an existing file's content (or start a fresh file).
 * Replaces a same-kind section in place rather than duplicating it, so re-saving
 * an updated prep brief doesn't pile up stale copies.
 *
 * @param {string | null} existing - current file content, or null if the file doesn't exist yet.
 * @param {keyof typeof SECTION_HEADINGS} kind
 * @param {string} company
 * @param {string} role
 * @param {string} body - the section's markdown body (no heading).
 * @returns {string} the full file content to write.
 */
export function mergeSection(existing, kind, company, role, body) {
  // kind is not validated against SECTION_HEADINGS here — an unknown kind
  // silently produces a "## undefined" heading. Left unchecked because the
  // only caller is the save route, which already validates kind before this
  // is reached; revisit if mergeSection ever gets a second caller.
  const heading = SECTION_HEADINGS[kind];
  const sectionText = `## ${heading}\n\n${body.trim()}`;
  if (!existing) {
    // company/role are interpolated verbatim into the title line with no
    // sanitization — a value containing "\n## " could inject a bogus section
    // boundary. Not this module's job to sanitize (it's plain string logic,
    // no knowledge of what's "safe" for the caller's context) — the save
    // route calling this should sanitize/escape before passing them in.
    return `# Interview Prep — ${company} — ${role}\n\n${sectionText}\n`;
  }
  // Split into [title, section, section, ...] on the newline before each "## "
  // heading, so a same-kind section can be swapped in place (by array index)
  // instead of relying on a regex spanning to "the next heading or EOF" — a
  // combined ^/m + $ regex can't express that boundary without $ also
  // matching every line end in between.
  const [titlePart, ...sectionParts] = existing.trimEnd().split(/\n(?=## )/);
  const matchIndex = sectionParts.findIndex((s) => s === `## ${heading}` || s.startsWith(`## ${heading}\n`));
  if (matchIndex === -1) {
    sectionParts.push(sectionText);
  } else {
    sectionParts[matchIndex] = sectionText;
  }
  // Each part still carries its own trailing "\n" from the original split (all
  // but the last section). Trim it before joining, so join("\n\n") is the
  // sole source of inter-section spacing — otherwise blank lines compound on
  // every re-save of a file with 2+ sections.
  return [titlePart.trimEnd(), ...sectionParts.map((s) => s.trimEnd())].join("\n\n") + "\n";
}
