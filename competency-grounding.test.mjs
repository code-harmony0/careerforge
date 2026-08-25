// Tests for the competency-grid grounding check in verify-cv-facts.mjs.
//
// Run:  node --test competency-grounding.test.mjs
//
// The bug these exist for, measured on a real generated CV (Huspy, 2026-08-25):
// the competency grid read "SOLID Engineering Principles", "PropTech &
// Marketplace Super Apps" and "Multi-Rail Payments & UAE FinTech" — none of
// which appear anywhere in cv.md. Every METRIC on that CV traced correctly, so
// the existing gate passed it: the gate checked numbers, employers and titles,
// and the competency grid was simply not a category it looked at.
//
// The grid is the easiest place for a tailoring pass to drift, because it is
// built FROM the job description by design. That is exactly why it needs to be
// checked AGAINST cv.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { competencyClaims, verifyFacts } from "./verify-cv-facts.mjs";

const CV = `# Arfat Rozewale
Senior React Native engineer. Mobile architecture, CI and CD, localization.
- Led the React Native 0.75 to 0.81 migration as an architecture cleanup.
- Established release engineering: Gradle flavors, Fastlane store-upload lanes.
- Rebuilt server state on TanStack Query and client state on Jotai.
- Delivered Arabic and English localization with right-to-left (RTL) layout.
`;

function tag(...tags) {
  return tags.map((t) => `<span class="competency-tag">${t}</span>`).join("\n");
}

/** A scratch dir holding a cv.md, so verifyFacts reads a known source. */
function withCv(fn) {
  const dir = mkdtempSync(join(tmpdir(), "competency-"));
  try {
    writeFileSync(join(dir, "cv.md"), CV);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("competencyClaims extracts the grid tags", () => {
  const claims = competencyClaims(tag("React Native & Mobile Architecture", "SOLID Engineering Principles"));
  assert.deepEqual(claims, ["React Native & Mobile Architecture", "SOLID Engineering Principles"]);
});

test("competencyClaims returns nothing when there is no grid", () => {
  assert.deepEqual(competencyClaims("<p>no competencies here</p>"), []);
});

test("a competency grounded in cv.md passes", () => {
  withCv((cwd) => {
    const r = verifyFacts(tag("React Native & Mobile Architecture"), { sourcePaths: ["cv.md"], cwd });
    assert.deepEqual(r.unsupportedCompetencies, []);
  });
});

test("SOLID Engineering Principles is flagged — the real Huspy regression", () => {
  withCv((cwd) => {
    const r = verifyFacts(tag("SOLID Engineering Principles"), { sourcePaths: ["cv.md"], cwd });
    assert.deepEqual(r.unsupportedCompetencies, ["SOLID Engineering Principles"]);
  });
});

test("an unsupported competency warns by default — it does not block the CV", () => {
  // This is YOUR resume and YOUR fork: the check tells you what is unsupported,
  // it does not decide for you. Reframing your own real work in a JD's
  // vocabulary is legitimate and common, and a hard stop on a judgement call
  // would just get switched off wholesale.
  withCv((cwd) => {
    const r = verifyFacts(tag("SOLID Engineering Principles"), { sourcePaths: ["cv.md"], cwd });
    assert.equal(r.verdict, "warn");
  });
});

test("strict mode is opt-in via config, for anyone who wants the hard stop", () => {
  const dir = mkdtempSync(join(tmpdir(), "competency-"));
  try {
    writeFileSync(join(dir, "cv.md"), CV);
    writeFileSync(join(dir, "cv-facts.json"), JSON.stringify({ block_unsupported_competencies: true }));
    const r = verifyFacts(tag("SOLID Engineering Principles"), {
      sourcePaths: ["cv.md"],
      configPath: "cv-facts.json",
      cwd: dir,
    });
    assert.equal(r.verdict, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tag is flagged when ANY of its terms is unsupported", () => {
  // "Multi-Rail Payments & UAE FinTech" — the payments half is real work, but
  // the tag as written also asserts FinTech domain experience. The tag is the
  // unit a reviewer reads, so the tag is the unit that must be supported.
  withCv((cwd) => {
    const r = verifyFacts(tag("Arabic & RTL Localization", "Multi-Rail Payments & UAE FinTech"), {
      sourcePaths: ["cv.md"],
      cwd,
    });
    assert.deepEqual(r.unsupportedCompetencies, ["Multi-Rail Payments & UAE FinTech"]);
  });
});

test("connectors and stopwords do not have to appear in cv.md", () => {
  // "&", "and", "of" carry no claim — requiring them would flag every tag.
  withCv((cwd) => {
    const r = verifyFacts(tag("Release Engineering & Fastlane CI/CD"), { sourcePaths: ["cv.md"], cwd });
    assert.deepEqual(r.unsupportedCompetencies, []);
  });
});

test("matching ignores case and possessive/plural noise", () => {
  withCv((cwd) => {
    const r = verifyFacts(tag("tanstack query & jotai"), { sourcePaths: ["cv.md"], cwd });
    assert.deepEqual(r.unsupportedCompetencies, []);
  });
});

test("an allow_facts entry lets a deliberate exception through", () => {
  // Reuses the existing exception channel rather than inventing a second one.
  const dir = mkdtempSync(join(tmpdir(), "competency-"));
  try {
    writeFileSync(join(dir, "cv.md"), CV);
    writeFileSync(join(dir, "cv-facts.json"), JSON.stringify({ allow_facts: ["SOLID Engineering Principles"] }));
    const r = verifyFacts(tag("SOLID Engineering Principles"), {
      sourcePaths: ["cv.md"],
      configPath: "cv-facts.json",
      cwd: dir,
    });
    assert.deepEqual(r.unsupportedCompetencies, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a document with no grid is unaffected", () => {
  withCv((cwd) => {
    const r = verifyFacts("<p>Led the React Native migration.</p>", { sourcePaths: ["cv.md"], cwd });
    assert.deepEqual(r.unsupportedCompetencies, []);
    assert.equal(r.verdict, "pass");
  });
});
