// tests/question-bank-migrate.test.mjs — migrate adds Level without losing rows
import { pass, fail, run, ROOT, NODE, rmSync, linkRepoPackage } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseQuestionBank, serializeQuestionBank } from '../lib/question-bank.mjs';

console.log('\nquestion-bank.mjs — migrate');

const dir = mkdtempSync(join(tmpdir(), 'qb-migrate-'));
mkdirSync(join(dir, 'interview-prep'), { recursive: true });
for (const f of ['question-bank.mjs', 'tracker-utils.mjs', 'tracker-parse.mjs', 'tracker-aliases.json', 'pipeline-lock.mjs', 'package.json']) cpSync(join(ROOT, f), join(dir, f));
cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
// tracker-utils.mjs imports js-yaml, which resolves by walking up from the
// sandbox's realpath and so never reaches the repo's node_modules. Without the
// link every spawned question-bank.mjs dies with ERR_MODULE_NOT_FOUND before it
// can parse argv -- and a crashed run leaves the bank untouched, which reads as
// "migrate preserved every row" rather than as the failure it is.
linkRepoPackage(dir, 'js-yaml');

const legacy = [
  '# Question Bank', '',
  '| ID | Question | Axis | Tag | Round | Source | Status | Asked | Last |',
  '|---|---|---|---|---|---|---|---|---|',
  '| q001 | What is JSI | tech | react-native | peer-tech | pack:rn | 🔴 | 2 | 2026-08-01 |',
  '| q002 | What is Hermes | tech | react-native | peer-tech | pack:rn | new | 0 |  |',
  '',
].join('\n');
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

run(NODE, ['question-bank.mjs', 'migrate'], { cwd: dir });
const twice = parseQuestionBank(readFileSync(bank, 'utf8')).questions;
if (twice.length === 2) pass('migrate is idempotent');
else fail(`second migrate changed row count to ${twice.length}`);

// Migration-on-write must be LOSSLESS: parse a legacy bank, serialize it under
// the new COLUMNS, reparse, and every original value must be intact. This is
// what would fail loudly if COLUMNS were ever reordered or the serializer went
// position-based instead of header-driven.
const legacyRows = parseQuestionBank(legacy).questions;
const reparsed = parseQuestionBank(serializeQuestionBank(legacyRows)).questions;
const lossless = legacyRows.every((r, i) =>
  ['id','question','axis','tag','round','source','status','asked'].every((k) => String(r[k] ?? '') === String(reparsed[i][k] ?? '')));
if (lossless) pass('legacy bank survives serialize under the new schema, losslessly');
else fail(`round-trip lost data:\n  before: ${JSON.stringify(legacyRows)}\n  after:  ${JSON.stringify(reparsed)}`);

rmSync(dir, { recursive: true, force: true });
