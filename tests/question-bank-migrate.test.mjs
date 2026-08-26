// tests/question-bank-migrate.test.mjs — `migrate` adopts a schema change on
// purpose: it must add the new column, refuse rather than drop rows it cannot
// parse, and do nothing at all (including to the .bak) when there is nothing to do.
import { pass, fail, run, ROOT, NODE, rmSync, linkRepoPackage } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseQuestionBank, serializeQuestionBank } from '../lib/question-bank.mjs';

console.log('\nquestion-bank.mjs — migrate');

/**
 * A throwaway checkout question-bank.mjs can run in.
 *
 * The script derives the bank's path from its OWN location, so it has to be
 * copied rather than invoked from the repo — otherwise every case here would
 * rewrite the developer's real interview-prep/question-bank.md.
 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'qb-migrate-'));
  mkdirSync(join(dir, 'interview-prep'), { recursive: true });
  for (const f of ['question-bank.mjs', 'tracker-utils.mjs', 'tracker-parse.mjs',
    'tracker-aliases.json', 'pipeline-lock.mjs', 'package.json']) {
    cpSync(join(ROOT, f), join(dir, f));
  }
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  // tracker-utils.mjs imports js-yaml, which resolves by walking up from the
  // sandbox's realpath and so never reaches the repo's node_modules. Without the
  // link every spawned question-bank.mjs dies with ERR_MODULE_NOT_FOUND before it
  // can parse argv -- and a crashed run leaves the bank untouched, which reads as
  // "migrate preserved every row" rather than as the failure it is.
  linkRepoPackage(dir, 'js-yaml');
  return dir;
}

const HEADER = [
  '| ID | Question | Axis | Tag | Round | Source | Status | Asked | Last |',
  '|---|---|---|---|---|---|---|---|---|',
];
const legacy = [
  '# Question Bank', '',
  ...HEADER,
  '| q001 | What is JSI | tech | react-native | peer-tech | pack:rn | 🔴 | 2 | 2026-08-01 |',
  '| q002 | What is Hermes | tech | react-native | peer-tech | pack:rn | new | 0 |  |',
  '',
].join('\n');

// ── a legacy bank is brought to the current schema, losslessly ───────────────
const dir = makeSandbox();
const bank = join(dir, 'interview-prep', 'question-bank.md');
writeFileSync(bank, legacy);

// run() returns null when the child exits non-zero. Checked alongside the row
// count so a crashed migrate cannot masquerade as a lossless one.
const ran = run(NODE, ['question-bank.mjs', 'migrate'], { cwd: dir });
const after = parseQuestionBank(readFileSync(bank, 'utf8')).questions;

if (ran !== null && after.length === 2) pass('migrate ran and preserved every row');
else fail(`migrate failed or lost rows (exit ok: ${ran !== null}): ${after.length} of 2 survived`);

if (after[0].status === '🔴' && after[0].asked === 2) pass('migrate preserved status and asked count');
else fail(`migrate corrupted row data: ${JSON.stringify(after[0])}`);

if ('level' in after[0]) pass('migrate added the level column');
else fail('migrate did not add level');

if (after[1].last === '') pass('an empty trailing cell stays empty, not "undefined"');
else fail(`empty cell corrupted to: ${JSON.stringify(after[1].last)}`);

// The .bak is the only undo a gitignored file has, so the first migrate must
// leave the PRE-migration bank in it.
if (readFileSync(`${bank}.bak`, 'utf8') === legacy) pass('the .bak holds the pre-migration bank');
else fail('the .bak is not the pre-migration bank');

// ── a second migrate is a true no-op, .bak included ──────────────────────────
// Row count alone would hold even if the second pass mangled every cell, and it
// says nothing about the .bak — which an unconditional rewrite would replace
// with the already-migrated bank, destroying the only copy of the original.
const beforeSecond = readFileSync(bank, 'utf8');
const bakBeforeSecond = readFileSync(`${bank}.bak`, 'utf8');
const secondRun = run(NODE, ['question-bank.mjs', 'migrate'], { cwd: dir });
if (secondRun !== null && readFileSync(bank, 'utf8') === beforeSecond) pass('a second migrate leaves the bank byte-identical');
else fail('a second migrate rewrote the bank');
if (readFileSync(`${bank}.bak`, 'utf8') === bakBeforeSecond) pass('a second migrate does not overwrite the .bak');
else fail('a second migrate destroyed the .bak — the pre-migration bank is unrecoverable');

rmSync(dir, { recursive: true, force: true });

// ── a row migrate cannot parse must stop it, not disappear ───────────────────
// Unlike add/status/seed, migrate delivers nothing else the user asked for, so
// dropping a hand-broken row would be its entire net effect.
const brokenDir = makeSandbox();
const brokenBank = join(brokenDir, 'interview-prep', 'question-bank.md');
const broken = [
  '# Question Bank', '',
  ...HEADER,
  '| q001 | What is JSI | tech | react-native | peer-tech | pack:rn | 🔴 | 2 | 2026-08-01 |',
  '| q002 | half a row |',
  '',
].join('\n');
writeFileSync(brokenBank, broken);
const brokenRun = run(NODE, ['question-bank.mjs', 'migrate'], { cwd: brokenDir });
if (brokenRun === null) pass('migrate refuses (non-zero exit) when a row is unparseable');
else fail(`migrate accepted an unparseable row and exited 0: ${brokenRun}`);
if (readFileSync(brokenBank, 'utf8') === broken) pass('the refused migrate left the bank byte-identical');
else fail('migrate rewrote the bank despite an unparseable row');
if (!existsSync(`${brokenBank}.bak`)) pass('the refused migrate did not even take a .bak');
else fail('migrate took a .bak on a run it refused');
rmSync(brokenDir, { recursive: true, force: true });

// ── migrate is not a bank-creating command ───────────────────────────────────
const emptyDir = makeSandbox();
const emptyBank = join(emptyDir, 'interview-prep', 'question-bank.md');
const emptyRun = run(NODE, ['question-bank.mjs', 'migrate'], { cwd: emptyDir });
if (emptyRun !== null && !existsSync(emptyBank)) pass('migrate does not create a bank when none exists');
else fail(`migrate created an empty bank (exit ok: ${emptyRun !== null}, exists: ${existsSync(emptyBank)})`);
rmSync(emptyDir, { recursive: true, force: true });

// ── the round-trip the Level column depends on ───────────────────────────────
// Migration-on-write must be LOSSLESS: parse a legacy bank, serialize it under
// the new COLUMNS, reparse, and every original value must be intact. This is
// what would fail loudly if COLUMNS were ever reordered or the serializer went
// position-based instead of header-driven. The length guard is not decoration:
// [].every() is true, so an unparseable fixture would otherwise report success
// for exactly the regression this exists to catch.
const legacyRows = parseQuestionBank(legacy).questions;
const reparsed = parseQuestionBank(serializeQuestionBank(legacyRows)).questions;
const lossless = legacyRows.length === 2 && legacyRows.every((r, i) =>
  ['id','question','axis','tag','round','source','status','asked','last'].every((k) => String(r[k] ?? '') === String(reparsed[i]?.[k] ?? '')));
if (lossless) pass('legacy bank survives serialize under the new schema, losslessly');
else fail(`round-trip lost data:\n  before: ${JSON.stringify(legacyRows)}\n  after:  ${JSON.stringify(reparsed)}`);
