#!/usr/bin/env node

// existing-report.mjs — has this posting already been evaluated?
//
// A pre-flight for anything about to spend tokens on an evaluation. Measured
// failure on 2026-08-25: the same Huspy posting was evaluated twice eight
// minutes apart, each run taking a fresh report number, producing two
// byte-identical files (041 and 042) and leaving row 41 of the tracker pointing
// at the second one. The tracker itself deduped correctly — merge-tracker.mjs
// upserts on the posting URL — but reports/ had no equivalent guard, so nothing
// stopped the second run from starting.
//
// Deliberately read-only and side-effect free: it answers the question and the
// caller decides. Refusing to start is a UI decision (with an override), not
// something a lookup should impose.
//
// URL normalization is NOT reimplemented here — url-key.mjs is the canonical
// posting key that merge-tracker.mjs already dedups on, and a second normalizer
// would eventually disagree with it about whether two rows are the same job.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { normalizeUrl } from './url-key.mjs';

const REPORT_RE = /^(\d{3})-(.+)-(\d{4}-\d{2}-\d{2})\.md$/;
const URL_RE = /^\*\*URL:\*\*\s*(\S+)/m;
const TITLE_RE = /^#\s*(.+)$/m;

/** Comparable form of a company or role: lowercase alphanumerics only. */
function fold(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every evaluated report on disk, newest number first.
 *
 * `*-RESERVED.md` sentinels fall out for free: REPORT_RE requires a trailing
 * date segment and a sentinel has none. That matters — a sentinel is an
 * in-flight reservation, not an evaluation, and counting one as an existing
 * report would block the very run that just reserved it. The test pins it.
 */
function readReports(reportsDir) {
  let files;
  try {
    files = readdirSync(reportsDir);
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const m = REPORT_RE.exec(f);
      if (!m) return null;
      let text = '';
      try {
        text = readFileSync(join(reportsDir, f), 'utf-8');
      } catch {
        return null;
      }
      const url = (URL_RE.exec(text) || [])[1] || '';
      const title = (TITLE_RE.exec(text) || [])[1] || '';
      // Report titles are written as "Company — Role" / "Company - Role".
      const [company = '', role = ''] = title.split(/\s+[—–-]\s+/);
      return { num: m[1], file: f, slug: m[2], url, company, role };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.num) - Number(a.num));
}

/**
 * The existing report for this posting, or null.
 *
 * Matched on the posting URL first, because it is the only signal that survives
 * a retitled listing and is the same key merge-tracker.mjs uses. Company+role
 * is the fallback for a posting with no URL — fuzzier, and deliberately second.
 *
 * @param {{root: string, url?: string, company?: string, role?: string}} args
 * @returns {{num: string, file: string, matchedOn: 'url'|'company+role'} | null}
 */
export function findExistingReport({ root, url = '', company = '', role = '' }) {
  const reports = readReports(join(root, 'reports'));
  if (!reports.length) return null;

  const key = url ? normalizeUrl(url) : '';
  if (key) {
    const hit = reports.find((r) => r.url && normalizeUrl(r.url) === key);
    if (hit) return { num: hit.num, file: hit.file, matchedOn: 'url' };
    // A URL was supplied and matched nothing. Company+role must NOT run as a
    // fallback here: a report carrying a DIFFERENT URL is positive evidence of a
    // different opening, the same way a differing req number is (AGENTS.md
    // #1524). Falling through would collapse two real postings into one.
    if (reports.some((r) => r.url)) return null;
  }

  if (company && role) {
    const c = fold(company);
    const rl = fold(role);
    const hit = reports.find((r) => fold(r.company) === c && fold(r.role) === rl);
    if (hit) return { num: hit.num, file: hit.file, matchedOn: 'company+role' };
  }
  return null;
}

export default findExistingReport;
