/**
 * cv-previews.mjs — where template preview PDFs live, and when they go stale.
 *
 * Plain .mjs (same pattern as pdf-paths.mjs / cv-envelope.mjs) so this is
 * unit-testable with `node --test`, no TypeScript build step. `root` is passed
 * in rather than importing career-ops.ts, keeping this module free of
 * TypeScript dependencies.
 *
 * Previews live under `.career-ops-web/` (scratch), NOT `output/`. output/ holds
 * the real tailored CVs the user sends to employers, and /api/cv-pdf serves the
 * newest file there matching a company slug — dropping seven look-alike CVs
 * beside them would eventually serve a preview to a recruiter.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PREVIEW_DIRNAME = path.join(".career-ops-web", "cv-previews");
const MANIFEST_NAME = "manifest.json";

/** Absolute path to the preview scratch directory for a career-ops root. */
export function previewDir(root) {
  return path.join(root, PREVIEW_DIRNAME);
}

/**
 * Absolute path to one template's preview PDF.
 *
 * `name` reaches a filesystem path, so it is restricted to the same character
 * class cv-templates.mjs's own filename pattern allows. Callers additionally
 * validate against the discovered template list; this is the second fence, not
 * the only one.
 */
export function previewPath(root, name) {
  if (!isSafeTemplateName(name)) throw new Error(`unsafe template name: ${name}`);
  return path.join(previewDir(root), `${name}.pdf`);
}

/**
 * Absolute path to one template's PNG thumbnail.
 *
 * The gallery grid shows the PNG, not the PDF. A PDF in an <iframe> renders
 * through the browser's built-in viewer, which is inconsistent across browsers,
 * heavy seven times over, and absent entirely in headless Chromium — where it
 * downloads instead of displaying, so no test could confirm the grid shows
 * anything. The PDF is still generated and is what the full-size link opens.
 */
export function thumbPath(root, name) {
  if (!isSafeTemplateName(name)) throw new Error(`unsafe template name: ${name}`);
  return path.join(previewDir(root), `${name}.png`);
}

/** The template-name shape cv-templates.mjs itself parses out of a filename. */
export function isSafeTemplateName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/**
 * Content hash of the CV the previews were built from.
 *
 * Hashing the CONTENT rather than stat-ing mtime because the editor writes
 * cv.md through atomicWriteWithBackup on every Save — including a Save that
 * changed nothing, which would bump mtime and invalidate seven good PDFs.
 */
export function cvHash(cvText) {
  return crypto.createHash("sha256").update(cvText ?? "", "utf8").digest("hex");
}

export function manifestPath(root) {
  return path.join(previewDir(root), MANIFEST_NAME);
}

/**
 * @returns {{cvHash: string|null, generatedAt: string|null, failed: string[]}}
 */
export function readManifest(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(root), "utf8"));
    return {
      cvHash: typeof raw.cvHash === "string" ? raw.cvHash : null,
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
      failed: Array.isArray(raw.failed) ? raw.failed.filter((f) => typeof f === "string") : [],
    };
  } catch {
    return { cvHash: null, generatedAt: null, failed: [] };
  }
}

export function writeManifest(root, { cvHash: hash, failed }) {
  const dir = previewDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath(root),
    JSON.stringify({ cvHash: hash, generatedAt: new Date().toISOString(), failed: failed ?? [] }, null, 2),
    "utf8",
  );
}

/**
 * State of one template's preview, as the gallery needs to render it.
 *
 * "stale" is distinct from "missing" on purpose: a stale preview is still shown
 * (it is the user's real CV, just an older draft of it) behind a regenerate
 * prompt, whereas a missing one has nothing to show at all.
 *
 * @returns {"ready"|"stale"|"missing"|"failed"}
 */
export function previewState(root, name, currentCvHash, manifest) {
  const m = manifest ?? readManifest(root);
  if (m.failed.includes(name)) return "failed";
  // Both artifacts must exist: the grid renders the PNG and the full-size link
  // opens the PDF, so either one alone is a half-built preview.
  let exists = false;
  try {
    exists = fs.statSync(previewPath(root, name)).size > 0 && fs.statSync(thumbPath(root, name)).size > 0;
  } catch {
    exists = false;
  }
  if (!exists) return "missing";
  if (!m.cvHash || !currentCvHash || m.cvHash !== currentCvHash) return "stale";
  return "ready";
}
