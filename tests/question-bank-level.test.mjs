// tests/question-bank-level.test.mjs — Level column round-trips and defaults safely
import { pass, fail } from './helpers.mjs';
import { COLUMNS, LEVELS, parseQuestionBank, serializeQuestionBank } from '../lib/question-bank.mjs';

console.log('\nlib/question-bank.mjs — Level column');

if (LEVELS.join(',') === 'beginner,moderate,senior') pass('LEVELS is the three market tiers');
else fail(`LEVELS wrong: ${JSON.stringify(LEVELS)}`);

if (COLUMNS.includes('Level')) pass('COLUMNS declares Level');
else fail('COLUMNS is missing Level');

// Round-trip: a row with a level survives serialize -> parse
const rows = [{ id: 'q001', question: 'What is JSI', axis: 'tech', tag: 'react-native', level: 'senior', status: 'new', asked: 0 }];
const back = parseQuestionBank(serializeQuestionBank(rows)).questions;
if (back[0]?.level === 'senior') pass('level survives a serialize/parse round-trip');
else fail(`level lost in round-trip: ${JSON.stringify(back[0])}`);

// A legacy 9-column bank (no Level header) must still parse, with level undefined.
const legacy = [
  '| ID | Question | Axis | Tag | Round | Source | Status | Asked | Last |',
  '|---|---|---|---|---|---|---|---|---|',
  '| q001 | What is JSI | tech | react-native | peer-tech | pack:rn | new | 0 |  |',
].join('\n');
const legacyRows = parseQuestionBank(legacy).questions;
if (legacyRows.length === 1) pass('legacy 9-column bank still parses (header-driven)');
else fail(`legacy bank lost rows: ${JSON.stringify(parseQuestionBank(legacy))}`);
if (legacyRows[0].level === undefined) pass('legacy row has no level rather than a wrong one');
else fail(`legacy row invented a level: ${legacyRows[0].level}`);
