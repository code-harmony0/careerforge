#!/usr/bin/env node

/**
 * cv-sync-check.mjs — Validates that the career-ops setup is consistent.
 *
 * Checks:
 * 1. cv.md exists
 * 2. config/profile.yml exists and has required fields
 * 3. No hardcoded metrics in _shared.md or batch/batch-prompt.md
 * 4. article-digest.md freshness (if exists)
 * 5. cv.md and config/profile.yml AGREE about the facts they both state
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const warnings = [];
const errors = [];

// 1. Check cv.md exists
const cvPath = join(projectRoot, 'cv.md');
if (!existsSync(cvPath)) {
  errors.push('cv.md not found in project root. Create it with your CV in markdown format.');
} else {
  const cvContent = readFileSync(cvPath, 'utf-8');
  if (cvContent.trim().length < 100) {
    warnings.push('cv.md seems too short. Make sure it contains your full CV.');
  }
}

// 2. Check profile.yml exists
const profilePath = join(projectRoot, 'config', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('config/profile.yml not found. Copy from config/profile.example.yml and fill in your details.');
} else {
  const profileContent = readFileSync(profilePath, 'utf-8');
  const requiredFields = ['full_name', 'email', 'location'];
  for (const field of requiredFields) {
    if (!profileContent.includes(field) || profileContent.includes(`"Jane Smith"`)) {
      warnings.push(`config/profile.yml may still have example data. Check field: ${field}`);
      break;
    }
  }
}

// 5. Do cv.md and profile.yml CONTRADICT each other?
//
// Checks 1 and 2 above ask whether the files EXIST. Nothing asked whether they
// agree — so on 2026-08-25 this script printed "All checks passed" while
// cv.md said "open to relocation" and profile.yml said "relocating to
// Bengaluru". modes/pdf.md maps candidate.location straight into the CV
// header, so the narrower of the two contradicting claims shipped in a PDF.
//
// Same failure class AGENTS.md already documents for story-bank provenance: a
// claim gets checked against A source, and the sources are never reconciled
// with EACH OTHER. Two sources of truth with no comparison is one source of
// truth and one silent liar.
function locationLine(text) {
  // The cv.md contact line: the header block before the first "##" section.
  const head = text.split(/^##\s/m)[0] || '';
  const line = head.split(/\r?\n/).find((l) => /@|linkedin|\|/i.test(l));
  return line ? line.trim() : '';
}

function significantPlaces(text) {
  // Capitalised place-ish words, minus the ones that are structural noise.
  const NOISE = new Set(['Email', 'Phone', 'LinkedIn', 'India', 'Open', 'Remote', 'Currently']);
  return new Set(
    (String(text).match(/\b[A-Z][a-z]{3,}\b/g) || []).filter((w) => !NOISE.has(w)),
  );
}

if (existsSync(cvPath) && existsSync(profilePath)) {
  const cvText = readFileSync(cvPath, 'utf-8');
  const profileText = readFileSync(profilePath, 'utf-8');
  const profileLocation = (profileText.match(/^\s*location:\s*(.+)$/m) || [])[1] || '';
  const cvLocation = locationLine(cvText);

  if (profileLocation && cvLocation) {
    const inProfile = significantPlaces(profileLocation);
    const inCv = significantPlaces(cvLocation);
    // A place named by exactly one of the two is a disagreement about a fact
    // both files state. Not an error — the user may have a reason — but it must
    // never be silent, because the generator will pick one without telling them.
    const onlyProfile = [...inProfile].filter((p) => !inCv.has(p));
    const onlyCv = [...inCv].filter((p) => !inProfile.has(p));
    if (onlyProfile.length || onlyCv.length) {
      warnings.push(
        `cv.md and config/profile.yml disagree about location. ` +
        `profile.yml: "${profileLocation.trim()}" · cv.md: "${cvLocation}". ` +
        `The CV header is built from profile.yml, so that is the version recruiters see.`,
      );
    }
  }
}

// 3. Check for hardcoded metrics in prompt files
const filesToCheck = [
  { path: join(projectRoot, 'modes', '_shared.md'), name: '_shared.md' },
  { path: join(projectRoot, 'modes', '_writing.md'), name: '_writing.md' },
  { path: join(projectRoot, 'batch', 'batch-prompt.md'), name: 'batch-prompt.md' },
];

// Pattern: numbers that look like hardcoded metrics (e.g., "170+ hours", "90% self-service")
const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/gi;

for (const { path, name } of filesToCheck) {
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf-8');

  // Skip lines that are clearly instructions (contain "NEVER hardcode" etc.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('NEVER hardcode') || line.includes('NUNCA hardcode') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const matches = line.match(metricPattern);
    if (matches) {
      warnings.push(`${name}:${i + 1} — Possible hardcoded metric: "${matches[0]}". Should this be read from cv.md/article-digest.md?`);
    }
  }
}

// 4. Check article-digest.md freshness
const digestPath = join(projectRoot, 'article-digest.md');
if (existsSync(digestPath)) {
  const stats = statSync(digestPath);
  const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (daysSinceModified > 30) {
    warnings.push(`article-digest.md is ${Math.round(daysSinceModified)} days old. Consider updating if your projects have new metrics.`);
  }
}

// Output results
console.log('\n=== career-ops sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  WARN: ${w}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
