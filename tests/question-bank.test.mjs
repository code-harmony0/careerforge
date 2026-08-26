// tests/question-bank.test.mjs
//
// Parsing and serializing interview-prep/question-bank.md. The file is
// user-layer, gitignored and hand-editable, so the parser's tolerance is a
// feature under test, not an accident.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuestionBank,
  serializeQuestionBank,
  nextId,
  questionKey,
  dueQuestions,
  COLUMNS,
} from "../lib/question-bank.mjs";

const row = (over = {}) => ({
  id: "q001",
  question: "Explain the bridge vs JSI",
  axis: "tech",
  tag: "react-native",
  level: "moderate",
  round: "peer-tech",
  source: "pack:react-native",
  status: "new",
  asked: 0,
  last: "",
  ...over,
});

test("round-trips a row through serialize -> parse unchanged", () => {
  const md = serializeQuestionBank([row()]);
  const { questions, skipped } = parseQuestionBank(md);
  assert.equal(skipped.length, 0);
  assert.equal(questions.length, 1);
  for (const c of COLUMNS.map((c) => c.toLowerCase())) {
    if (c === "asked") continue; // parsed back as a number, compared below
    assert.equal(questions[0][c], String(row()[c]), `column ${c}`);
  }
  assert.equal(questions[0].asked, 0);
});

test("a question containing a pipe survives the table", () => {
  // Real interview questions contain pipes: "explain `a || b` vs `a ?? b`".
  // A naive split("|") loses everything after the first one.
  const q = "Explain `a || b` vs `a ?? b`";
  const { questions } = parseQuestionBank(serializeQuestionBank([row({ question: q })]));
  assert.equal(questions[0].question, q);
});

test("a question containing a backslash survives too", () => {
  const q = "What does the regex \\d+ match?";
  const { questions } = parseQuestionBank(serializeQuestionBank([row({ question: q })]));
  assert.equal(questions[0].question, q);
});

test("columns are resolved by NAME, not position", () => {
  // This is what lets a second parser live in web/ without drifting: neither
  // side hardcodes an order, so adding a column breaks nothing.
  const md = [
    "| Question | Status | ID |",
    "|---|---|---|",
    "| Why this company? | 🔴 | q009 |",
  ].join("\n");
  const { questions } = parseQuestionBank(md);
  assert.equal(questions[0].id, "q009");
  assert.equal(questions[0].status, "🔴");
  assert.equal(questions[0].question, "Why this company?");
});

test("one malformed row is skipped and reported, the rest survive", () => {
  const md = [
    "| ID | Question | Status |",
    "|---|---|---|",
    "| q001 | good row | new |",
    "| q002 | too few cells |",
    "| q003 | another good one | 🟡 |",
  ].join("\n");
  const { questions, skipped } = parseQuestionBank(md);
  assert.deepEqual(questions.map((q) => q.id), ["q001", "q003"]);
  assert.deepEqual(skipped, [4], "reports the 1-indexed line so a caller can say so out loud");
});

test("a row with no ID is skipped rather than stored unaddressable", () => {
  const md = "| ID | Question |\n|---|---|\n|  | orphan |\n| q002 | keeper |";
  const { questions, skipped } = parseQuestionBank(md);
  assert.deepEqual(questions.map((q) => q.id), ["q002"]);
  assert.deepEqual(skipped, [3]);
});

test("a table that is not the bank is ignored", () => {
  // Prose examples and legends are tables too. Requiring ID + Question is what
  // stops the parser latching onto one and mapping the wrong column to status.
  const md = "| Round | Length |\n|---|---|\n| screen | 30m |\n";
  const { questions, header } = parseQuestionBank(md);
  assert.deepEqual(questions, []);
  assert.deepEqual(header, []);
});

test("empty, missing and prose-only input parse to nothing, never throw", () => {
  for (const input of ["", null, undefined, "# Question Bank\n\nNothing here yet.\n"]) {
    assert.doesNotThrow(() => parseQuestionBank(input));
    assert.deepEqual(parseQuestionBank(input).questions, []);
  }
});

test("nextId is max+1, so deleting a row cannot cause a collision", () => {
  assert.equal(nextId([]), "q001");
  assert.equal(nextId([row({ id: "q001" }), row({ id: "q007" })]), "q008");
  // length+1 would return q003 here and collide with the existing q009.
  assert.equal(nextId([row({ id: "q001" }), row({ id: "q009" })]), "q010");
  assert.equal(nextId([row({ id: "not-an-id" })]), "q001");
});

test("questionKey collapses the spellings the same question arrives in", () => {
  const a = questionKey("Explain the bridge vs JSI");
  assert.equal(questionKey("explain the bridge vs. JSI?"), a);
  assert.equal(questionKey("  Explain   the Bridge vs JSI  "), a);
  assert.notEqual(questionKey("Explain the bridge"), a);
});

test("dueQuestions: red first, then stale yellow, then new; fresh yellow and green are not due", () => {
  const qs = [
    row({ id: "q001", status: "✅", last: "2026-01-01" }),
    row({ id: "q002", status: "new" }),
    row({ id: "q003", status: "🟡", last: "2026-08-23" }), // 1 day old, still fresh
    row({ id: "q004", status: "🟡", last: "2026-07-01" }), // stale
    row({ id: "q005", status: "🔴", last: "2026-08-20" }),
  ];
  const due = dueQuestions(qs, { today: "2026-08-24" }).map((q) => q.id);
  assert.deepEqual(due, ["q005", "q004", "q002"]);
});

test("dueQuestions: within a tier, the question more companies asked comes first", () => {
  const qs = [
    row({ id: "q001", status: "🔴", asked: 1 }),
    row({ id: "q002", status: "🔴", asked: 3 }),
  ];
  assert.deepEqual(dueQuestions(qs, { today: "2026-08-24" }).map((q) => q.id), ["q002", "q001"]);
});

test("dueQuestions: an unparseable or missing date counts as infinitely stale", () => {
  // Never-practised must surface, not silently sort as fresh.
  const qs = [row({ id: "q001", status: "🟡", last: "" }), row({ id: "q002", status: "🟡", last: "not-a-date" })];
  assert.deepEqual(dueQuestions(qs, { today: "2026-08-24" }).map((q) => q.id), ["q001", "q002"]);
});
