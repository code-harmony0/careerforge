// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EURES provider — the European Commission's official cross-EU/EEA job portal
// (2M+ live postings). Reverse-engineered public search endpoint (undocumented,
// no auth, but requires a same-origin Referer header or it 400s):
//   POST https://europa.eu/eures/api/jv-searchengine/public/jv-search/search
//   body: {"page": N, "resultsPerPage": M}   (1-indexed page)
//   -> { numberRecords, jvs: [ { title, id, creationDate, locationMap,
//        euresFlag, employer: { name }, ... } ], facets }
//
// No server-side keyword search parameter was found during reverse-engineering
// (every guessed field name — keyword/keywords/query/searchText/criteria —
// returned a strict-schema 400), so this is a bulk board-wide feed like
// arbeitnow/thehub: scan.mjs's title_filter does all the narrowing. Results
// come back newest-first by default (no sortSelection needed).
//
// `euresFlag: true` marks a posting the employer has specifically opted into
// EURES's cross-border mobility support (relocation/mobility assistance) —
// surfaced in `location` as a trailing "EURES" tag, since that's a direct
// visa/relocation-relevance signal.
//
// Job detail pages (`/eures/portal/jv-se/jv-details/{id}`) are an Angular SPA
// shell that resolves the id client-side — identical HTTP response for any id,
// real or fake — so the URL is display-only (never fetched here), same as
// every other provider's dedup-key URL.
//
// Wire in via a `job_boards:` entry with `provider: eures`.

const SEARCH_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const REFERER = 'https://europa.eu/eures/portal/jv-se/search';
const DETAILS_BASE = 'https://europa.eu/eures/portal/jv-se/jv-details/';
const PER_PAGE = 50; // the API 400s ("Too many results per page were requested") above 50
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 50;

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Normalize a single EURES job vacancy (jv). Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (items without one are dropped).
 *   - url:      built from `id` (required — no id, no URL, dropped) as
 *               `${DETAILS_BASE}${encodeURIComponent(id)}?lang=en`.
 *   - company:  `employer.name`, falling back to the portal entry name, then "EURES".
 *   - location: ISO country codes from `locationMap`'s keys, joined with
 *               ", "; ", EURES" appended when `euresFlag` is true (opted into
 *               cross-border mobility support — a relocation/visa signal).
 *   - postedAt: `creationDate` (epoch ms) — used as-is (no unit conversion).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalizeEuresJob(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  const id = typeof j.id === 'string' ? j.id.trim() : '';
  if (!id) return null;
  const url = `${DETAILS_BASE}${encodeURIComponent(id)}?lang=en`;

  const company =
    j.employer && typeof j.employer.name === 'string' && j.employer.name.trim()
      ? j.employer.name.trim()
      : fallbackCompany || 'EURES';

  const countries =
    j.locationMap && typeof j.locationMap === 'object' ? Object.keys(j.locationMap).filter(Boolean) : [];
  const location = [countries.join(', '), j.euresFlag === true ? 'EURES' : ''].filter(Boolean).join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number }} */
  const job = { title, url, company, location };
  if (Number.isFinite(j.creationDate)) job.postedAt = j.creationDate;
  return job;
}

/** @type {Provider} */
export default {
  id: 'eures',

  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const json = await ctx.fetchJson(SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: REFERER },
        body: JSON.stringify({ page, resultsPerPage: PER_PAGE }),
        redirect: 'error', // SSRF guard
      });
      if (!json || !Array.isArray(json.jvs)) {
        throw new Error(
          `eures: unexpected API response on page ${page} — expected { jvs: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
        );
      }
      for (const j of json.jvs) {
        const normalized = normalizeEuresJob(j, fallbackCompany);
        if (normalized) out.push(normalized);
      }
      if (json.jvs.length < PER_PAGE) break; // short page → last page reached
    }
    return out;
  },
};
