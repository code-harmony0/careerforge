// web/src/lib/chat-attachment.mjs
// Saves a chat-composer image attachment (screenshot or pasted/picked file) to
// a scratch file so the headless CLI can Read it — Claude Code's Read tool is
// multimodal for image files, so handing it a path is enough; there is no
// separate image API to call. Plain .mjs (no TS) so this is unit-testable with
// `node --test`, same pattern as pdf-paths.mjs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_BYTES = 8 * 1024 * 1024; // generous for a full-tab screenshot, bounded against abuse

/**
 * @param {{root: string, dataUrl: unknown}} args
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function saveChatImage({ root, dataUrl }) {
  if (typeof dataUrl !== "string") return { ok: false, error: "no image data" };
  const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!m) return { ok: false, error: "unrecognized image data" };
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) return { ok: false, error: `unsupported image type: ${m[1]}` };
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch {
    return { ok: false, error: "malformed base64" };
  }
  if (buf.length === 0 || buf.length > MAX_BYTES) return { ok: false, error: "image is empty or too large" };
  const dir = path.join(root, ".career-ops-web", "chat-attachments");
  fs.mkdirSync(dir, { recursive: true });
  // Random, not derived from any user-supplied name — nothing here is a path
  // an attacker chooses, so there's no traversal surface to guard against.
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file };
}

/** Best-effort cleanup once the run that read the file is done — never throws. */
export function deleteChatImage(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone, or was never written */
  }
}
