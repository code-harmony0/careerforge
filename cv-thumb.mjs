#!/usr/bin/env node

// cv-thumb.mjs — render a built CV HTML page to a PNG thumbnail.
//
//   node cv-thumb.mjs <input.html> <output.png> [--width=850]
//
// The web app's template gallery needs seven CV previews side by side. Embedding
// seven PDFs was the obvious first try and is the wrong tool: a PDF in an
// <iframe> depends on the browser's built-in viewer, which renders differently
// across browsers, cannot be styled or scaled reliably, is heavy seven times
// over, and does not render AT ALL in headless Chromium — so no automated test
// could ever confirm the gallery was showing anything. A PNG is an <img>.
//
// generate-pdf.mjs stays the single PDF renderer and is untouched; this is its
// screenshot-shaped sibling and deliberately does not share its section-order
// guards, page-count warnings or tracker wiring. A thumbnail is a picture of a
// layout, not a document anyone sends to an employer.

import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { pathToFileURL } from 'url';

// Letter width at 100dpi. Only the first page is captured: the gallery card is a
// single page-shaped tile, and clipping to the viewport is what keeps a
// three-page CV from producing a tall, unreadably-scaled strip.
const DEFAULT_WIDTH = 850;
const LETTER_RATIO = 11 / 8.5;

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const [input, output] = positional;

  if (!input || !output || args.includes('--help')) {
    console.error('Usage: node cv-thumb.mjs <input.html> <output.png> [--width=850]');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  const widthArg = args.find((a) => a.startsWith('--width='));
  const parsed = widthArg ? Number.parseInt(widthArg.slice('--width='.length), 10) : DEFAULT_WIDTH;
  // A non-numeric or absurd --width would otherwise reach Playwright's viewport
  // and throw deep inside the browser launch, where the error says nothing about
  // the flag that caused it.
  const width = Number.isFinite(parsed) && parsed >= 200 && parsed <= 4000 ? parsed : DEFAULT_WIDTH;
  const height = Math.round(width * LETTER_RATIO);

  const absInput = resolve(input);
  const absOutput = resolve(output);
  if (!existsSync(absInput)) {
    console.error(`Input file not found: ${absInput}`);
    process.exit(1);
  }
  await mkdir(dirname(absOutput), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      // The card is displayed small; 2x keeps the text from turning to mush on a
      // retina screen without paying for a full-size render.
      deviceScaleFactor: 2,
    });
    await page.goto(pathToFileURL(absInput).href, { waitUntil: 'networkidle' });
    // `fullPage: false` is the point — see the clipping note above.
    await page.screenshot({ path: absOutput, fullPage: false });
    console.log(`Thumbnail written: ${absOutput}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`Thumbnail render failed: ${err.message}`);
  process.exit(1);
});
