// tests/providers/eures.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — eures');

try {
  const euresModule = await import(pathToFileURL(join(ROOT, 'providers/eures.mjs')).href);
  const eures = euresModule.default;
  const { normalizeEuresJob } = euresModule;

  if (eures.id === 'eures') pass('eures.id is "eures"');
  else fail(`eures.id is ${JSON.stringify(eures.id)}`);

  // normalizeEuresJob — field mapping.
  const full = normalizeEuresJob(
    { title: '  Senior Backend Engineer  ', id: 'abc/def', employer: { name: '  Acme GmbH  ' }, locationMap: { DE: ['DE300'] }, euresFlag: true, creationDate: 1782693032000 },
    'Fallback',
  );
  if (full && full.title === 'Senior Backend Engineer' && full.url === 'https://europa.eu/eures/portal/jv-se/jv-details/abc%2Fdef?lang=en'
      && full.company === 'Acme GmbH' && full.location === 'DE, EURES' && full.postedAt === 1782693032000) {
    pass('normalizeEuresJob maps + trims fields, URL-encodes the id, and tags EURES-flagged postings');
  } else {
    fail(`normalizeEuresJob full row = ${JSON.stringify(full)}`);
  }

  // euresFlag false/absent → no "EURES" tag.
  const noFlag = normalizeEuresJob({ title: 'T', id: 'x1', locationMap: { FR: ['FR10'] } }, 'X');
  if (noFlag?.location === 'FR') pass('normalizeEuresJob omits the EURES tag when euresFlag is not true');
  else fail(`normalizeEuresJob noFlag location = ${JSON.stringify(noFlag?.location)}`);

  // multi-country locationMap joins keys.
  const multi = normalizeEuresJob({ title: 'T', id: 'x2', locationMap: { DE: ['DE300'], AT: ['AT1'] } }, 'X');
  if (multi?.location === 'DE, AT') pass('normalizeEuresJob joins multiple locationMap country codes');
  else fail(`normalizeEuresJob multi location = ${JSON.stringify(multi?.location)}`);

  // company fallbacks: entry name, then "EURES".
  const coFromEntry = normalizeEuresJob({ title: 'T', id: 'c1', employer: { name: '' } }, 'Entry Name');
  const coDefault = normalizeEuresJob({ title: 'T', id: 'c2' });
  if (coFromEntry?.company === 'Entry Name' && coDefault?.company === 'EURES') {
    pass('normalizeEuresJob falls back company → entry name → "EURES"');
  } else {
    fail(`normalizeEuresJob company fallbacks = ${JSON.stringify({ a: coFromEntry?.company, b: coDefault?.company })}`);
  }

  // drops: empty title, missing id, non-object.
  const drops = [
    normalizeEuresJob({ title: '', id: 'd1' }),
    normalizeEuresJob({ title: 'No id' }),
    normalizeEuresJob(null),
  ];
  if (drops.every(r => r === null)) pass('normalizeEuresJob drops empty-title / missing-id / non-object');
  else fail(`normalizeEuresJob drops = ${JSON.stringify(drops)}`);

  // missing creationDate → no postedAt key.
  const noDate = normalizeEuresJob({ title: 'T', id: 'nd' });
  if (noDate && !('postedAt' in noDate)) pass('normalizeEuresJob omits postedAt when creationDate is absent');
  else fail(`normalizeEuresJob postedAt presence = ${JSON.stringify(noDate)}`);

  // fetch(): POST pagination, referer header, stop on a short page.
  const mk = (i) => ({ title: `Role ${i}`, id: `id-${i}`, employer: { name: `Co ${i}` }, locationMap: { DE: ['DE300'] }, creationDate: 1782693032000 + i });
  const page1 = Array.from({ length: 50 }, (_, i) => mk(i)); // full page → continue
  const page2 = [mk(50), mk(51), { title: '', id: 'bad' }]; // short page (3 < 50) → stop; 1 drop
  const requested = [];
  const pagedFetch = async (url, opts) => {
    requested.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body, redirect: opts?.redirect });
    const { page } = JSON.parse(opts.body);
    if (page === 1) return { numberRecords: 202, jvs: page1 };
    if (page === 2) return { numberRecords: 202, jvs: page2 };
    return { numberRecords: 202, jvs: [] };
  };

  const paged = await eures.fetch({ name: 'EURES' }, { fetchJson: pagedFetch });

  if (requested.length === 2 && requested.every(r => r.url === 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search' && r.method === 'POST')) {
    pass('eures.fetch() POSTs to the search endpoint and stops after the short page');
  } else {
    fail(`eures.fetch() requested = ${JSON.stringify(requested)}`);
  }

  if (requested.every(r => r.headers?.referer === 'https://europa.eu/eures/portal/jv-se/search')) {
    pass('eures.fetch() sends the required Referer header on every request');
  } else {
    fail(`eures.fetch() headers = ${JSON.stringify(requested.map(r => r.headers))}`);
  }

  if (requested.every(r => r.redirect === 'error')) pass('eures.fetch() passes redirect:"error" on every page (SSRF guard)');
  else fail(`eures.fetch() redirect opts = ${JSON.stringify(requested.map(r => r.redirect))}`);

  if (paged.length === 52) pass('eures.fetch() aggregates valid jobs across pages (50 + 2, dropping the empty-title row)');
  else fail(`eures.fetch() returned ${paged.length} jobs (expected 52)`);

  // max_pages cap: only the first page is requested even though it is full.
  const capRequested = [];
  await eures.fetch(
    { name: 'EURES', max_pages: 1 },
    { fetchJson: async (url) => { capRequested.push(url); return { jvs: Array.from({ length: 50 }, (_, i) => mk(i)) }; } },
  );
  if (capRequested.length === 1) pass('eures.fetch() honors max_pages (stops at the cap even on a full page)');
  else fail(`eures.fetch() max_pages:1 requested ${capRequested.length} times`);

  // unexpected API response → throws.
  let badThrew = false;
  try {
    await eures.fetch({ name: 'X' }, { fetchJson: async () => ({ wrong: true }) });
  } catch (e) {
    badThrew = /unexpected API response/.test(e.message);
  }
  if (badThrew) pass('eures.fetch() throws on unexpected API response shape');
  else fail('eures.fetch() should throw when jvs is absent');

} catch (e) {
  fail(`eures provider tests crashed: ${e.message}`);
}
