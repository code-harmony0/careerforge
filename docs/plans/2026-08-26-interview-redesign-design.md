# Interview section redesign — design

**Date:** 2026-08-26
**Status:** approved, ready for implementation planning

## Problem

The interview surface has three defects the user named directly:

1. **Questions are generic.** `templates/question-packs/*.md` are hand-curated
   lists. They are not what the market is actually asking.
2. **Everything shows at once.** `question-bank-view.tsx` renders all 60 rows in
   one filterable list. There is no session, no selection, no sense of progress.
3. **The flow is inverted.** The right pane asks the user to type an answer and
   grades their wording. It never tells them the answer. Preparation requires
   learning first, self-testing second.

Plus two structural problems found while investigating:

4. `modes/interview.md` is profile onboarding, not interview prep — a naming
   collision with everything below.
5. `interview-prep/story-bank.md` does not exist, so the behavioural axis has no
   substrate at all.

## Mind map

```
INTERVIEW
├─ § 1  SELF        pitch builder → drills → story bank        [NEW]
├─ § 2  TECHNICAL   harvested bank → deck → card loop          [REBUILD]
├─ § 3  COMPANY     interview-prep · plan · practice · debrief [EXISTS, untouched]
└─ DATA             packs · question-bank.md · harvest/ · story-bank.md
```

## § A — Sourcing: harvest, not curate

Three tiers, discovered by live search:

| Tier | Source | Volume | Extraction |
|---|---|---|---|
| 1 Corpora | GitHub Q&A repos (`sudheerj/reactjs-interview-questions`, `Devinterview-io/*`, `aershov24/typescript-interview-questions`) | High | Cheap — raw markdown, already Q+A paired |
| 2 Experience reports | Reddit, Medium interview writeups, freeCodeCamp forum | Low, highest signal | LLM pass, questions buried in prose |
| 3 Glassdoor/Blind | Per-company | — | **Cut** — login-gated, ToS-hostile; covered by § 3 |

Tier 2 is the differentiator: real questions from real recent loops. Tier 2 rows
sort first in a deck.

### Pipeline — `question-harvest.mjs`

```
1. SEARCH   firecrawl, per stack × level × intent
2. LEDGER   interview-prep/harvest/harvest-log.tsv
            url │ sha1(content) │ date │ n_extracted
            seen + unchanged hash → SKIP, zero cost
3. FETCH    tier 1 raw github .md · tier 2 firecrawl scrape
4. EXTRACT  one LLM pass/page → {question, level, topic, answer_short,
                                 answer_more, source_url, tier}
5. DEDUP    stage 1 questionKey()  exact, exists, free
            stage 2 trigram shortlist → LLM merge, rides step 4's call
6. APPEND   rows → question-bank.md (through the lock)
            answers → interview-prep/harvest/{stack}/qNNN.md
```

Step 2 mirrors `data/scan-history.tsv`, the scanner's existing dedup ledger.
Re-harvesting later costs nothing for unchanged pages and appends only new
questions. Step 5 answers "not every question should repeat" — `questionKey()`
is exact-normalized-string only, so paraphrases currently both land.
Upgrade path for recall: local embeddings via the already-running
`embeddinggemma:300m`.

### Cache location — load-bearing

`templates/` is in `SYSTEM_PATHS` (update-system.mjs:298) and `apply` checks out
every entry from upstream. **Harvested content in `templates/question-packs/`
would be silently destroyed by the next update.** It lives in the user layer:

```
interview-prep/harvest/
├── harvest-log.tsv          url │ hash │ date │ n
├── react-native/qNNN.md     answer + frontmatter: source_url, tier, license
└── typescript/qNNN.md
```

`templates/question-packs/` stays as the free zero-cost starter set for fresh
installs. New paths get added to DATA_CONTRACT.md.

### Security

AGENTS.md "Untrusted External Content" is CRITICAL and this is the most
injection-exposed surface in the repo — it LLM-processes arbitrary Reddit and
Medium pages.

- Extraction prompt frames page content as untrusted data; emits only the fixed
  JSON schema.
- The harvester writes to exactly two places: the bank (via lock) and `harvest/`.
- Imperative text aimed at "the AI" is recorded as an anomaly on the row, never
  obeyed.

### Licensing

Tier 1 is MIT/CC-BY, safe to store. Tier 2 is not redistributable — harvested
content stays local and gitignored, never committed, never shipped upstream.

### Schema

- `Level` column on the bank: `beginner | moderate | senior`. Add to `COLUMNS`
  and a `LEVELS` export in `lib/question-bank.mjs`; mirror the facet in
  `web/src/lib/question-bank-read.mjs` (two parsers, must stay in sync).
- `parseQuestionBank` skips rows whose cell count ≠ header length, so migration
  must rewrite the whole file atomically: `node question-bank.mjs migrate`.

## § B — The card loop

`dueQuestions()` in `lib/question-bank.mjs` already *is* the deck algorithm:
🔴 first, then 🟡 stale past 14 days, then `new`, dropping fresh ✅. Spaced
repetition is already written and tested. Deck = `dueQuestions(filtered).slice(0, 15)`.

One surface, not two. The existing "write your own answer + local feedback" panel
is the *practice* half and is kept — the bug is that it was the only half. The
card absorbs it.

```
Stack × Level × Topic → 15 cards
  card: question → [Reveal] → short answer
                 → [Explain more]     free, pack tier 2
                 → [Ask a follow-up]  paid, /api/assistant scoped to
                                      question + answer + cv.md
                 → grade ✅🟡🔴 → next
  end: scorecard grouped by topic, weak topics pre-fill next deck
```

Three cost tiers; only the third is paid, and only because it depends on what
the user got confused about — it cannot be written in advance.

Grading writes through the CLI (`PATCH /api/questions` already shells out to
`node question-bank.mjs status` to hold the lock). No new write path.

### Cut (YAGNI)

Timers, voice recording, streaks/XP/daily goals, a separate browse-all screen.

## § C — The self-intro half

`interview-prep/story-bank.md` does not exist; this creates it.

```
1 DRAFT   reads ONLY cv.md · config/profile.yml · modes/_profile.md ·
          article-digest.md → 60-90s pitch, no invented numbers
2 GROUND  extractClaims(pitch) vs cv.md — free, local, already written in
          web/src/lib/answer-analysis.mjs
3 EDIT    user edits → interview-prep/pitch.md (canonical)
4 DRILL   30s cut · Why leaving · Why us · Walk my CV — all derive from canonical
5 HARVEST stories told → story-bank.md with **Provenance:** markers
```

### The confirmation UX invariant

AGENTS.md specifies a four-outcome confirmation flow for `derived-unverified`
numbers and states that building it is "separate future work".
`story-provenance-check.mjs` already implements the four-bucket classifier.
**The UI half has never been built.** Step 2 is its natural home.

Four outcomes, never a confirm/deny binary — a confirmed guess launders a guess
into a verified fact:

- accurate as written → `user-stated YYYY-MM-DD`
- real figure is N → `user-stated` + corrected
- not a number claim → narrative-only, figure dropped
- I don't know → `user-cannot-confirm`, durable, never decays back to verified

`user-cannot-confirm` claims stay as narrative texture but are never rendered as
quantified claims in interview-facing output. This ships infrastructure the CV
generator, cover letters, and per-company prep all benefit from.

### Cut (YAGNI)

Per-company pitch copies (drift), tone sliders (editing is faster).

## § D — Housekeeping

Rename `modes/interview.md` → `modes/profile-interview.md` (system layer, safe).

## Files touched

| File | Change |
|---|---|
| `question-harvest.mjs` | NEW — the pipeline |
| `lib/question-pack.mjs` | NEW — pack/answer parser |
| `lib/question-bank.mjs` | `LEVELS`, `Level` in `COLUMNS` |
| `web/src/lib/question-bank-read.mjs` | mirror the level facet |
| `question-bank.mjs` | `migrate` cmd; `seed` gains level |
| `web/src/components/interview/question-bank-view.tsx` | → picker + card + scorecard |
| `web/src/app/api/questions/explain/route.ts` | NEW — paid tier 3 |
| pitch builder + provenance UI | NEW — § C |
| `DATA_CONTRACT.md`, `AGENTS.md` | document `interview-prep/harvest/`, `pitch.md` |
| `modes/interview.md` | rename |

No new npm dependencies.
