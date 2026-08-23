/**
 * answer-analysis.mjs — everything worth telling someone about their interview
 * answer that costs nothing to compute.
 *
 * This runs BEFORE any model is called, and for most answers it is the whole
 * feedback. A four-minute reply to a screening question is the actual problem
 * with that reply, and no LLM is needed to notice; neither is one needed to
 * count how many times "basically" appears.
 *
 * Google's Interview Warmup established the shape: after an answer, show the
 * job-related terms used, the most-repeated words, and whether the expected
 * points were covered. All three are counting problems.
 *
 * The grounding check is ours and is the part that matters most. AGENTS.md's
 * Source-of-Truth Boundary forbids inventing claims about the user, so an
 * answer containing a number that appears nowhere in cv.md is worth surfacing —
 * either it is real and belongs in the CV, or it is about to be said out loud
 * to someone who will ask a follow-up. Every competitor will happily help
 * rehearse a claim that cannot be defended.
 *
 * Plain .mjs so node:test drives it directly.
 */

/**
 * Words spoken per minute. Interview answers are SPOKEN, and people speak far
 * slower than they read silently (~250wpm), so scoring length against a reading
 * rate makes every duration estimate wrong by nearly half. 140 is mid-range for
 * measured conversational speech; the UI states the assumption rather than
 * presenting the number as fact.
 */
export const SPEAKING_WPM = 140;

/** Verbal padding. Each entry is matched on word boundaries, case-insensitively. */
const FILLERS = [
  "basically", "actually", "literally", "obviously", "essentially", "honestly",
  "you know", "i mean", "kind of", "sort of", "um", "uh", "like i said",
];

/**
 * Hedges are tracked separately from fillers because they do different damage.
 * A filler is noise; a hedge actively undercuts the claim it is attached to,
 * which matters most on exactly the answers where you are asserting competence.
 */
const HEDGES = [
  "i think", "i guess", "i would say", "maybe", "probably", "perhaps",
  "a little bit", "somewhat", "i believe", "hopefully", "more or less", "i suppose",
];

/** Openers that signal the answer leads with an outcome instead of a wind-up. */
const RESULT_VERBS = [
  "shipped", "cut", "reduced", "increased", "grew", "led", "launched", "saved",
  "migrated", "rebuilt", "delivered", "owned", "scaled", "fixed", "removed",
  "doubled", "halved", "automated", "replaced", "took", "built", "drove",
];

/** Words too common to be worth reporting as "most repeated". */
const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those i me my we our you your it its is are was were be been being have has had do does did will would can could should of to in on at for with from as by so not no yes about into over under just too very really then when what which who how why there here their them they he she his her".split(" ")),
);

function words(text) {
  return String(text ?? "").toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [];
}

function countPhrase(haystack, phrase) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
  return (haystack.match(re) ?? []).length;
}

/**
 * Terms from the CV worth checking an answer against.
 *
 * Reads the Skills section as a comma-separated list (which is how cv.md is
 * actually written: "Languages: TypeScript, JavaScript, ..."), then falls back
 * to multi-word capitalized phrases elsewhere. Deliberately conservative: a
 * false term produces a wrong "you mentioned this" claim, which is worse than
 * missing one.
 *
 * @param {string} cv
 * @returns {string[]}
 */
export function extractCvTerms(cv) {
  const text = String(cv ?? "");
  const terms = new Set();
  const skills = /^#+\s*skills\s*$([\s\S]*?)(?=^#+\s|\Z)/im.exec(text);
  if (skills) {
    for (const line of skills[1].split("\n")) {
      const after = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
      for (const raw of after.split(/[,•|]/)) {
        const t = raw.replace(/[*_`]/g, "").replace(/\(.*?\)/g, "").trim();
        if (t.length >= 2 && t.length <= 40 && /[\p{L}]/u.test(t)) terms.add(t);
      }
    }
  }
  // Fallback for a CV with no Skills section: MULTI-WORD capitalized phrases
  // only. A single capitalized word is usually just the start of a sentence
  // ("Led a team of six" yielded the term "Led"), and claiming the user
  // "mentioned Led from your CV" is precisely the false positive this function
  // is documented as preferring to avoid. A missed term costs nothing; an
  // invented one makes the panel untrustworthy.
  for (const m of text.matchAll(/\b([A-Z][\p{L}0-9.+#-]*(?:\s+[A-Z][\p{L}0-9.+#-]*){1,2})\b/gu)) {
    const t = m[1].trim();
    if (t.length >= 3 && t.length <= 40) terms.add(t);
  }
  return [...terms];
}

/**
 * Numeric claims in a piece of text, normalized for comparison.
 *
 * "40%", "40 %" and "40 percent" are the same claim; "2019" is a year, not a
 * metric, and flagging every date as an unsupported statistic would make the
 * grounding check noise. Small counts (under 3) are skipped for the same reason.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractClaims(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/(\d[\d,._]*)\s*(%|percent|x|k\b|m\b|million|billion|hours?|days?|weeks?|months?|years?|users?|customers?|people|engineers?|developers?)?/gi)) {
    const raw = m[1].replace(/[,_]/g, "");
    const num = Number.parseFloat(raw);
    if (!Number.isFinite(num)) continue;
    if (num >= 1900 && num <= 2100 && !m[2]) continue; // a year, not a metric
    if (num < 3 && !m[2]) continue;                    // "2 things" is not a claim
    out.add(String(num));
  }
  return [...out];
}

/**
 * Analyse an answer. Everything here is deterministic and free.
 *
 * @param {{answer: string, cv?: string, question?: string}} args
 * @returns {object}
 */
export function analyseAnswer({ answer, cv = "", question = "" }) {
  const text = String(answer ?? "");
  const w = words(text);
  const wordCount = w.length;
  const seconds = Math.round((wordCount / SPEAKING_WPM) * 60);

  const fillers = FILLERS.map((f) => ({ phrase: f, count: countPhrase(text, f) })).filter((x) => x.count > 0);
  const hedges = HEDGES.map((h) => ({ phrase: h, count: countPhrase(text, h) })).filter((x) => x.count > 0);

  const freq = new Map();
  for (const word of w) {
    if (STOPWORDS.has(word) || word.length < 4) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  const repeated = [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  // Does it open with the point? interview-prep.md's own answer frame is
  // Headline / Effect / Rationale / Operations, and the headline is the part
  // people skip.
  const firstSentence = (text.split(/(?<=[.!?])\s/)[0] ?? "").trim();
  const firstWords = words(firstSentence);
  const leadsWithResult =
    /\d/.test(firstSentence) || firstWords.some((x) => RESULT_VERBS.includes(x));

  const cvTerms = extractCvTerms(cv);
  const mentioned = cvTerms.filter((t) => countPhrase(text, t.toLowerCase()) > 0);

  // Grounding: numbers asserted here that appear nowhere in the CV. Phrased by
  // the UI as a question, never an accusation — keyword matching WILL produce
  // false positives, and a check that feels like an accusation gets ignored,
  // which destroys the only feature here that competitors do not have.
  const cvClaims = new Set(extractClaims(cv));
  const unsupportedClaims = extractClaims(text).filter((c) => !cvClaims.has(c));

  return {
    wordCount,
    seconds,
    spokenEstimate: `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
    speakingWpm: SPEAKING_WPM,
    // Ranges come from what interviewers actually allow: a recruiter screen
    // question wants 60-90s, a technical one runs longer. Under 40 words is
    // usually an answer that stopped before it made a point.
    lengthVerdict: wordCount < 40 ? "short" : seconds > 180 ? "long" : "ok",
    fillers,
    fillerCount: fillers.reduce((n, x) => n + x.count, 0),
    hedges,
    hedgeCount: hedges.reduce((n, x) => n + x.count, 0),
    repeated,
    leadsWithResult,
    firstSentence,
    cvTermsMentioned: mentioned,
    unsupportedClaims,
    questionEcho: question ? words(question).filter((x) => !STOPWORDS.has(x) && x.length > 3 && w.includes(x)).length : 0,
  };
}
