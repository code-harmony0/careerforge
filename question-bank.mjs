#!/usr/bin/env node
/**
 * question-bank.mjs — the only writer of `interview-prep/question-bank.md`.
 *
 * WHY THIS EXISTS. Four mode files (interview/plan.md, practice.md,
 * debrief.md, and the web's run-prompts.mjs) instruct the agent to read this
 * bank and never re-ask a question already covered in it. None of them create
 * it. The only specified writer was debrief.md Step 3, which runs after a real
 * interview — so for anyone who has not yet been interviewed, the bank does not
 * exist and the deduplication those files promise has never once happened.
 *
 * WHY A SCRIPT AND NOT A MODE. The bank lives in interview-prep/, which is
 * gitignored user layer: there is no version history to recover a bad write
 * from. So writes go through one path that takes a lock and replaces the file
 * atomically, exactly as set-status.mjs does for the tracker. An agent editing
 * this file directly is the failure mode this script exists to prevent.
 *
 * Usage:
 *   node question-bank.mjs list [--axis tech] [--tag react-native] [--status 🔴] [--summary]
 *   node question-bank.mjs add "question text" --axis tech --tag react-native [--round peer-tech]
 *   node question-bank.mjs status <id> <new|🔴|🟡|✅> [--note "..."]
 *   node question-bank.mjs due [--limit 10] [--summary]
 *   node question-bank.mjs seed [--stack react-native,javascript] [--dry-run]
 *
 * Exit codes: 0 ok · 1 usage/validation error · 4 lock timeout (busy, retry).
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { writeFileAtomic, acquireTrackerLock } from './tracker-utils.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  parseQuestionBank, serializeQuestionBank, nextId, questionKey, dueQuestions,
  AXES, ROUNDS, STATUSES,
} from './lib/question-bank.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BANK = join(ROOT, 'interview-prep', 'question-bank.md');
const PACKS = join(ROOT, 'templates', 'question-packs');

const EXIT = { OK: 0, USAGE: 1, LOCK: 4 };

const USAGE = `question-bank — the only writer of interview-prep/question-bank.md

  list  [--axis tech] [--tag react-native] [--status 🔴] [--round peer-tech] [--q text] [--limit N] [--summary]
  add   "question text" --axis <tech|role|company|behavioural> [--tag X] [--round Y] [--source Z]
  status <id> <new|🔴|🟡|✅> [--asked]
  due   [--limit N] [--stale 14] [--summary]
  seed  [--stack react-native,javascript] [--dry-run] [--summary]

JSON by default; --summary prints a human table. Exit: 0 ok · 1 usage · 4 busy.`;

function die(msg, code = EXIT.USAGE) {
  console.error(`question-bank: ${msg}`);
  process.exit(code);
}

/** Own lock dir, keyed by the bank's path. Deliberately NOT the tracker's lock:
 *  a long merge-tracker run must not block adding a question, and vice versa. */
function lockDir() {
  const key = createHash('sha256').update(BANK).digest('hex').slice(0, 16);
  return join(realpathSync(tmpdir()), `career-ops-question-bank-${key}.lock`);
}

function readBank() {
  if (!existsSync(BANK)) return { questions: [], skipped: [] };
  const parsed = parseQuestionBank(readFileSync(BANK, 'utf8'));
  if (parsed.skipped.length) {
    // Loud, not silent: a skipped row is a question the user can no longer see.
    console.error(`question-bank: skipped unparseable row(s) at line ${parsed.skipped.join(', ')} — fix them by hand or they stay invisible.`);
  }
  return parsed;
}

/** Write under lock, keeping one .bak. The file is gitignored, so this backup is
 *  the only undo that exists. */
async function writeBank(questions) {
  const lock = await acquireTrackerLock(lockDir(), { timeoutMs: 30_000 }).catch(() => null);
  if (!lock) die('another question-bank write is in progress — retry in a moment.', EXIT.LOCK);
  try {
    mkdirSync(dirname(BANK), { recursive: true });
    if (existsSync(BANK)) copyFileSync(BANK, `${BANK}.bak`);
    writeFileAtomic(BANK, serializeQuestionBank(questions));
  } finally {
    lock.release?.();
  }
}

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else positional.push(a);
}
const asJson = !flags.summary;

function out(data, summaryFn) {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else summaryFn(data);
}

// ── commands ─────────────────────────────────────────────────────────────────
async function main() {
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }

  if (cmd === 'list' || cmd === 'due') {
    const { questions } = readBank();
    let rows = cmd === 'due'
      ? dueQuestions(questions, { today: localToday(), staleDays: Number(flags.stale) || 14 })
      : questions;
    for (const [key, val] of [['axis', flags.axis], ['tag', flags.tag], ['status', flags.status], ['round', flags.round]]) {
      if (val && val !== true) rows = rows.filter((q) => String(q[key] ?? '').toLowerCase() === String(val).toLowerCase());
    }
    if (flags.q && flags.q !== true) {
      const needle = questionKey(flags.q);
      rows = rows.filter((q) => questionKey(q.question).includes(needle));
    }
    if (flags.limit) rows = rows.slice(0, Number(flags.limit));
    out({ schema_version: 1, count: rows.length, total: questions.length, questions: rows }, (d) => {
      if (!d.count) return console.log(cmd === 'due' ? 'Nothing due. Add questions with `seed` or `add`.' : 'Bank is empty.');
      console.log(`${d.count} of ${d.total} question(s)\n`);
      for (const q of d.questions) {
        console.log(`${q.status || 'new'} ${q.id}  [${q.axis}/${q.tag}]  ${q.question}`);
      }
    });
    return;
  }

  if (cmd === 'add') {
    const text = positional.join(' ').trim() || (typeof flags.question === 'string' ? flags.question : '');
    if (!text) die('add needs the question text.');
    const axis = String(flags.axis ?? 'behavioural');
    if (!AXES.includes(axis)) die(`--axis must be one of: ${AXES.join(', ')}`);
    const round = String(flags.round ?? 'any');
    if (!ROUNDS.includes(round)) die(`--round must be one of: ${ROUNDS.join(', ')}`);

    const { questions } = readBank();
    const key = questionKey(text);
    const dup = questions.find((q) => questionKey(q.question) === key);
    if (dup) {
      // Not an error. The whole point of the bank is that the same question
      // arrives from a pack, a prep brief and a debrief; saying so beats
      // either failing or quietly creating a near-identical row.
      out({ schema_version: 1, added: false, duplicateOf: dup.id, question: dup.question },
        (d) => console.log(`Already in the bank as ${d.duplicateOf}.`));
      return;
    }
    const row = {
      id: nextId(questions),
      question: text,
      axis,
      tag: String(flags.tag ?? ''),
      round,
      source: String(flags.source ?? 'manual'),
      status: 'new',
      asked: 0,
      last: '',
    };
    await writeBank([...questions, row]);
    out({ schema_version: 1, added: true, question: row }, (d) => console.log(`Added ${d.question.id}.`));
    return;
  }

  if (cmd === 'status') {
    const [id, status] = positional;
    if (!id || !status) die('status needs <id> <new|🔴|🟡|✅>');
    if (!STATUSES.includes(status)) die(`status must be one of: ${STATUSES.join(' ')}`);
    const { questions } = readBank();
    const q = questions.find((x) => x.id === id);
    if (!q) die(`no question with id ${id}`);
    q.status = status;
    q.last = localToday();
    // `asked` counts REAL interview occurrences, so only a debrief bumps it —
    // practising a question at your desk is not a company asking it.
    if (flags.asked) q.asked = (Number(q.asked) || 0) + 1;
    await writeBank(questions);
    out({ schema_version: 1, updated: q }, (d) => console.log(`${d.updated.id} → ${d.updated.status}`));
    return;
  }

  if (cmd === 'seed') {
    if (!existsSync(PACKS)) die(`no packs at ${PACKS}`);
    const { readdirSync } = await import('node:fs');
    const available = readdirSync(PACKS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    const wanted = flags.stack && flags.stack !== true
      ? String(flags.stack).split(',').map((s) => s.trim()).filter(Boolean)
      : available;
    const unknown = wanted.filter((w) => !available.includes(w));
    if (unknown.length) die(`unknown pack(s): ${unknown.join(', ')}. Available: ${available.join(', ')}`);

    const { questions } = readBank();
    const seen = new Set(questions.map((q) => questionKey(q.question)));
    const added = [];
    let next = questions.length;
    for (const pack of wanted) {
      const body = readFileSync(join(PACKS, `${pack}.md`), 'utf8');
      for (const line of body.split('\n')) {
        const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const text = m[1].replace(/^\*\*|\*\*$/g, '').trim();
        if (text.length < 12) continue; // headings-as-bullets, not questions
        const key = questionKey(text);
        if (seen.has(key)) continue;
        seen.add(key);
        const row = {
          id: `q${String(++next).padStart(3, '0')}`,
          question: text,
          axis: 'tech',
          tag: pack,
          round: 'peer-tech',
          source: `pack:${pack}`,
          status: 'new',
          asked: 0,
          last: '',
        };
        added.push(row);
      }
    }
    // Re-key against the real bank so ids cannot collide with a deleted row.
    let n = questions.length ? Number.parseInt(nextId(questions).slice(1), 10) : 1;
    for (const row of added) row.id = `q${String(n++).padStart(3, '0')}`;

    if (flags['dry-run']) {
      out({ schema_version: 1, wouldAdd: added.length, packs: wanted, sample: added.slice(0, 5) },
        (d) => console.log(`Would add ${d.wouldAdd} question(s) from: ${d.packs.join(', ')}`));
      return;
    }
    if (added.length) await writeBank([...questions, ...added]);
    out({ schema_version: 1, added: added.length, packs: wanted, total: questions.length + added.length },
      (d) => console.log(`Added ${d.added} question(s) from ${d.packs.join(', ')}. Bank now holds ${d.total}.`));
    return;
  }

  die(`unknown command "${cmd}". Try: list, add, status, due, seed.`);
}

main().catch((e) => die(e?.message ?? String(e)));
