// web/src/lib/slugify.mjs
//
// The path-slug rule, on its own, with no Node imports.
//
// It lives here rather than in pdf-paths.mjs because BOTH sides need it: the
// server, to decide where a file goes, and the browser, to ask whether that
// file already exists before offering to pay for regenerating it. pdf-paths.mjs
// imports node:fs, so importing slugify from there into a client component
// dragged node:fs into the browser bundle and broke the build.
//
// One definition, two consumers. pdf-paths.mjs re-exports it, so every existing
// importer is unaffected and the slug a client computes is provably the slug
// the server writes.

/**
 * Lowercase, non-alphanumeric runs -> single hyphen, trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
