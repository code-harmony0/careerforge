// web/tests/lib/answer-analysis.test.mjs
//
// The free pass: everything worth telling someone about an interview answer
// that costs no tokens. Run: node --test tests/lib/answer-analysis.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseAnswer, extractCvTerms, extractClaims, SPEAKING_WPM } from "../../src/lib/answer-analysis.mjs";

const CV = `# CV

## Skills

Mobile: React Native, Hermes, Reanimated, FlashList
State and Data: TanStack Query, Jotai

## Experience

Cut cold start by 40% across 12 screens. Shipped to 50000 users.
`;

test("length is scored against SPEAKING rate, not reading rate", () => {
  // People speak at ~140wpm and read silently at ~250. Scoring a spoken answer
  // against a reading rate makes every duration estimate nearly half wrong.
  const answer = Array.from({ length: SPEAKING_WPM }, () => "word").join(" ");
  const a = analyseAnswer({ answer, cv: "" });
  assert.equal(a.wordCount, SPEAKING_WPM);
  assert.equal(a.seconds, 60, "one minute of words is one minute of speech");
});

test("length verdicts: short, ok, long", () => {
  assert.equal(analyseAnswer({ answer: "Yes, I have." }).lengthVerdict, "short");
  assert.equal(analyseAnswer({ answer: Array(120).fill("word").join(" ") }).lengthVerdict, "ok");
  assert.equal(analyseAnswer({ answer: Array(600).fill("word").join(" ") }).lengthVerdict, "long");
});

test("fillers and hedges are counted separately", () => {
  // They do different damage: a filler is noise, a hedge undercuts the claim
  // it is attached to.
  const a = analyseAnswer({ answer: "Basically, I think we actually shipped it. I guess." });
  assert.equal(a.fillerCount, 2, "basically + actually");
  assert.equal(a.hedgeCount, 2, "i think + i guess");
});

test("filler matching respects word boundaries", () => {
  // "um" inside "album" is not a filler, and flagging it would train the user
  // to ignore the whole panel.
  const a = analyseAnswer({ answer: "I shipped the album feature and the umbrella config." });
  assert.equal(a.fillerCount, 0);
});

test("leadsWithResult: a number or a result verb in the first sentence", () => {
  assert.equal(analyseAnswer({ answer: "Cut cold start by half. Then we..." }).leadsWithResult, true);
  assert.equal(analyseAnswer({ answer: "We reduced it to 400ms. Here is how." }).leadsWithResult, true);
  assert.equal(
    analyseAnswer({ answer: "So at my previous company there was a situation where things were slow." }).leadsWithResult,
    false,
  );
});

test("repeated words skip stopwords and short words", () => {
  const a = analyseAnswer({ answer: "the the the and and and Hermes Hermes Hermes Hermes" });
  assert.deepEqual(a.repeated, [{ word: "hermes", count: 4 }]);
});

test("extractCvTerms reads the Skills section as a comma list", () => {
  const terms = extractCvTerms(CV);
  for (const t of ["React Native", "Hermes", "TanStack Query", "FlashList"]) {
    assert.ok(terms.includes(t), `expected ${t}`);
  }
});

test("cvTermsMentioned reports only terms actually used in the answer", () => {
  const a = analyseAnswer({ answer: "We moved the list to FlashList and enabled Hermes.", cv: CV });
  assert.ok(a.cvTermsMentioned.includes("FlashList"));
  assert.ok(a.cvTermsMentioned.includes("Hermes"));
  assert.ok(!a.cvTermsMentioned.includes("Jotai"), "not mentioned, must not be claimed");
});

test("extractClaims ignores years and trivial counts", () => {
  // Flagging every date as an unsupported statistic would make the grounding
  // check pure noise.
  assert.deepEqual(extractClaims("I joined in 2019 and led 2 projects"), []);
  assert.deepEqual(extractClaims("cut it by 40%"), ["40"]);
  assert.deepEqual(extractClaims("in 2019 we served 50000 users"), ["50000"]);
});

test("extractClaims normalizes the spellings of one number", () => {
  assert.deepEqual(extractClaims("40%"), extractClaims("40 percent"));
  assert.deepEqual(extractClaims("1,200 users"), ["1200"]);
});

test("grounding: a number not in the CV is surfaced; one that is, is not", () => {
  // The feature no competitor has. "40" and "12" are in the CV; "6" and "55"
  // are not, and are about to be said out loud to someone who will follow up.
  const a = analyseAnswer({ answer: "I led a team of 6 and cut latency 55%, across 12 screens by 40%.", cv: CV });
  assert.deepEqual(a.unsupportedClaims.sort(), ["55", "6"]);
});

test("grounding stays quiet when every number is backed", () => {
  const a = analyseAnswer({ answer: "Cut cold start 40% across 12 screens for 50000 users.", cv: CV });
  assert.deepEqual(a.unsupportedClaims, []);
});

test("empty and nullish input never throw", () => {
  for (const answer of ["", null, undefined, "   "]) {
    assert.doesNotThrow(() => analyseAnswer({ answer, cv: CV }));
    assert.equal(analyseAnswer({ answer, cv: CV }).wordCount, 0);
  }
  assert.doesNotThrow(() => analyseAnswer({ answer: "hi" }));
  assert.deepEqual(extractCvTerms(""), []);
});

test("extractCvTerms does not invent single-word terms from sentence starts", () => {
  // "Led a team of six" once produced the term "Led", so an answer beginning
  // "Led the migration" was reported back as "you mentioned Led from your CV".
  // A missed term costs nothing; an invented one makes the whole panel
  // untrustworthy, which kills the feature.
  const terms = extractCvTerms("# CV\n\n## Experience\n\nLed a team. Shipped the thing. Owned delivery.\n");
  assert.ok(!terms.includes("Led"), "single sentence-initial word must not become a term");
  assert.ok(!terms.includes("Shipped"));
  assert.ok(!terms.includes("Owned"));
});

test("extractCvTerms still finds multi-word names when there is no Skills section", () => {
  const terms = extractCvTerms("# CV\n\n## Experience\n\nMigrated to React Native at Acme Corp.\n");
  assert.ok(terms.includes("React Native"));
  assert.ok(terms.includes("Acme Corp"));
});
