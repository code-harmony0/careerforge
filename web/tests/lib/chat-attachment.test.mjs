// Tests for chat-attachment.mjs — saving a chat-composer image attachment to a
// scratch file the headless CLI can Read (Claude Code's Read tool is
// multimodal), and cleaning it up afterward.
//
// Run:  node --test tests/lib/chat-attachment.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveChatImage, deleteChatImage } from "../../src/lib/chat-attachment.mjs";

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "co-chat-attach-"));
}

test("saves a valid data URL to a file under .career-ops-web/chat-attachments", () => {
  const root = tmpRoot();
  const result = saveChatImage({ root, dataUrl: `data:image/png;base64,${ONE_PX_PNG_BASE64}` });
  assert.equal(result.ok, true);
  assert.ok(result.path.startsWith(path.join(root, ".career-ops-web", "chat-attachments")));
  assert.ok(result.path.endsWith(".png"));
  assert.ok(fs.existsSync(result.path));
  assert.deepEqual(fs.readFileSync(result.path), Buffer.from(ONE_PX_PNG_BASE64, "base64"));
});

test("rejects non-data-URL input", () => {
  const root = tmpRoot();
  const result = saveChatImage({ root, dataUrl: "not a data url" });
  assert.equal(result.ok, false);
});

test("rejects a data URL that is not an image mime type", () => {
  const root = tmpRoot();
  const result = saveChatImage({ root, dataUrl: "data:text/plain;base64,aGVsbG8=" });
  assert.equal(result.ok, false);
});

test("rejects an unrecognized field entirely (not a string)", () => {
  const root = tmpRoot();
  const result = saveChatImage({ root, dataUrl: undefined });
  assert.equal(result.ok, false);
});

test("rejects a data URL over the size cap", () => {
  const root = tmpRoot();
  // ~12MB of base64, comfortably over the 8MB decoded cap.
  const huge = "A".repeat(16_000_000);
  const result = saveChatImage({ root, dataUrl: `data:image/png;base64,${huge}` });
  assert.equal(result.ok, false);
});

test("deleteChatImage removes the file", () => {
  const root = tmpRoot();
  const { path: file } = saveChatImage({ root, dataUrl: `data:image/png;base64,${ONE_PX_PNG_BASE64}` });
  assert.ok(fs.existsSync(file));
  deleteChatImage(file);
  assert.equal(fs.existsSync(file), false);
});

test("deleteChatImage never throws for a missing or empty path", () => {
  assert.doesNotThrow(() => deleteChatImage(path.join(tmpRoot(), "nope.png")));
  assert.doesNotThrow(() => deleteChatImage(undefined));
  assert.doesNotThrow(() => deleteChatImage(""));
});

test("two saves in the same root never collide on a filename", () => {
  const root = tmpRoot();
  const a = saveChatImage({ root, dataUrl: `data:image/png;base64,${ONE_PX_PNG_BASE64}` });
  const b = saveChatImage({ root, dataUrl: `data:image/png;base64,${ONE_PX_PNG_BASE64}` });
  assert.notEqual(a.path, b.path);
});
