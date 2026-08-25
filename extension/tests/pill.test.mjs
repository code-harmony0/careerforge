// Browser tests for the floating pill: drag, and the scroll fade.
//
// Run:  node --test tests/pill.test.mjs   (skips if playwright isn't installed)
//
// These exist because both bugs here were invisible to unit tests:
//   - the fade shipped with `pointer-events: none`, which left the pill
//     ungrabbable for the full 600ms after ANY scroll — precisely when you
//     reach for it. Measured: scroll, drag immediately, nothing moved.
//   - drag itself is pointer-capture behaviour that only a real browser has.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pill.html")).href;

let chromium;
before(async () => {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    chromium = null;
  }
});

async function withPill(fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test("the pill drags", async (t) => {
  if (!chromium) return t.skip("playwright not installed");
  const moved = await withPill(async (page) => {
    const pill = page.locator("#career-ops-pill");
    const before = await pill.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(before.x - 40 * i, before.y - 30 * i);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await pill.boundingBox();
    return Math.abs(after.x - before.x) > 20 && Math.abs(after.y - before.y) > 20;
  });
  assert.ok(moved, "pill did not move");
});

test("the pill fades while the page scrolls", async (t) => {
  if (!chromium) return t.skip("playwright not installed");
  const faded = await withPill(async (page) => {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(80);
    return page.evaluate(() => document.getElementById("career-ops-pill").classList.contains("co-scrolling"));
  });
  assert.ok(faded);
});

test("a faded pill is still grabbable — the regression that shipped once", async (t) => {
  if (!chromium) return t.skip("playwright not installed");
  const grabbable = await withPill(async (page) => {
    const pill = page.locator("#career-ops-pill");
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(80);
    const box = await pill.boundingBox();
    // First press wakes the faded pill, second drags it.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y - 90);
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await pill.boundingBox();
    return Math.abs(after.x - box.x) > 20;
  });
  assert.ok(grabbable, "pill could not be grabbed after scrolling");
});
