# Career Studio — Interview prep as a real workspace, plus a growth layer

> **Status:** PROPOSAL. Not approved, nothing implemented. Read the Critique section before starting.
> **For Claude:** when this is approved, use `superpowers:executing-plans` and implement task-by-task. Phase 0 first, standalone.

---

## Part 1 — Diagnosis (what is actually wrong, from the code)

### 1.1 The reading problem is three lines of code

| # | Location | Problem |
|---|---|---|
| D1 | `web/src/app/interview/page.tsx:7` | The whole page is `max-w-2xl` (672px). A 3,000-word brief with 7-column tables is squeezed into a phone-width column on a desktop monitor. |
| D2 | `web/src/components/interview-form.tsx:361` and `:301` | Output renders as `<pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">`. Raw markdown, monospace, in a **384px-tall scroll box**. No headings, no table rendering, no anchors, no way to jump. |
| D3 | Same `<pre>`, streaming | The box scrolls as tokens arrive, so when the run finishes you are parked somewhere in the middle — "it starts from step 5" is exactly this. There is no scroll-to-top, no section index, no "done" state that resets the viewport. |

`react-markdown` + `remark-gfm` are **already dependencies**. `web/src/components/report-view.tsx` already renders markdown with progressive disclosure, table overflow containers, and `splitSections()` from `web/src/lib/report-sections.mjs`. The interview view simply never got that treatment. This is not a hard problem — it is an unfinished one.

### 1.2 The bigger problem: the engine is far ahead of the UI

The CLI side already has a complete interview system. The web exposes **two of four modes** and **none of the persistence**.

| Engine capability | File | Exposed in web? |
|---|---|---|
| Company prep brief | `modes/interview-prep.md` (29KB, 7 steps, audience maps, round-by-round) | Partially — dumped as raw text |
| Time-blocked plan | `modes/interview/plan.md` | Partially — same raw dump |
| Live practice interviewer w/ per-answer feedback | `modes/interview/practice.md` | **No** |
| Post-interview debrief → gap closing → story extraction | `modes/interview/debrief.md` | **No** |
| Red-flag / is-this-company-safe analysis | `modes/interview-redflag.md` (24KB) | **No** |
| Accumulated STAR stories | `interview-prep/story-bank.md` | **No** |
| Question bank (what you've been asked, what you fumbled) | `interview-prep/question-bank.md` | **No** |
| Session transcripts | `interview-prep/sessions/*.md` | **No** |
| Weekly rollup of rounds + recurring gaps | `weekly-digest.mjs` | **No** |

And `/api/interview/save` writes prep to `interview-prep/{slug}.md` — but **nothing in the web reads it back**. There is already one saved brief on disk (`qrusible-full-stack-senior-engineer-react-native.md`) that the UI cannot show you. Every visit means paying for a re-run of work you already paid for. That is the most expensive bug on this page.

### 1.3 The career-growth feature is ~70% already built

Everything asked for — "should I upskill, should I switch, am I underpaid, where do I get better jobs" — has a **zero-LLM script** in the repo that emits clean JSON, with no UI attached:

| Question the user asks | Script that already answers it | Cost |
|---|---|---|
| What skills should I learn? | `upskill.mjs` — weighted gap map vs the roles you actually got rejected from | free |
| Am I underpaid / what should I ask for? | `salary-gap.mjs`, `negotiation-roi.mjs` | free |
| Why do I keep getting rejected? | `analyze-patterns.mjs` (incl. per-ATS advance rate), `funnel-velocity.mjs` vs market benchmarks | free |
| Which job titles should I also target? | `modes/titles.md` | 1 LLM run |
| Does my CV cover this JD? | `jd-skill-gap.mjs` | free |
| Are my certs current? | `assessment-log.mjs` | free |
| Are companies ghosting me post-interview? | `rejection-latency.mjs`, `process-quality.mjs` | free |
| Are roles being re-posted (i.e. fake)? | `detect-reposts.mjs` | free |

Verified working: `node upskill.mjs` returns `{schema_version, metadata:{reportsLinked:29,...}, gaps:[{skill:"Swift", weightedScore:4.8, tier:"Low", sources:[29,27,24]}...]}`.

**So the "career growth project" is mostly a wiring job over existing, free, deterministic engines — not a new AI product.** That is the single most important finding in this document, because it changes the cost profile from "6 LLM calls per page load" to "one `Promise.all` of child processes."

---

## Part 2 — The proposal

Rename the destination. `/interview` becomes **Studio** — two tabs, one nav entry:

```
Studio
├── Prep      — per-company: brief, plan, practice, debrief, red-flag
└── Growth    — cross-company: skills, comp, funnel, targeting, roadmap
```

### Phase 0 — Make it readable (standalone, ships alone, ~half a day)

Fixes D1/D2/D3. No new features, no new API, no LLM cost change.

**Files:**
- `web/src/app/interview/page.tsx` — drop `max-w-2xl`, adopt the wide reading shell (`max-w-5xl` prose column, full-width tables)
- `web/src/components/interview/prep-document.tsx` — **new**. Renders a finished brief as markdown, reusing `report-view.tsx`'s `markdownComponents` table pattern.
- `web/src/components/interview/document-outline.tsx` — **new**. Sticky left rail built from the `##` headings the mode file guarantees (`Process Overview`, `Audience Map`, `Round-by-Round`, `Likely Questions`, `Story Bank Mapping`, `Technical Prep Checklist`, `Company Signals`). Click to jump. This is what kills "it starts at step 5".
- `web/src/components/interview/interview-form.tsx` — modify. `<pre>` becomes: **while running**, a dim live tail (streaming markdown renders badly — partial tables break); **when done**, swap to `<PrepDocument>` and scroll to top.

Two things it must do that the current page does not:
1. **Print / export.** A prep brief is read on a phone in a lobby 20 minutes before the call. `@media print` styles + a "Save as PDF" button, and the existing `generate-pdf.mjs` Playwright path is already there.
2. **Focus mode.** One keystroke collapses nav + chat console to give the document the full window.

### Phase 1 — Stop paying twice (~half a day)

**Files:**
- `web/src/app/api/interview/route.ts` — **new** `GET`. Lists `interview-prep/*.md` (excluding `story-bank.md`, `question-bank.md`, `sessions/`) with company, role, mtime. `GET ?slug=` returns one.
- `web/src/components/interview/prep-library.tsx` — **new**. Grid of saved briefs. Opening one costs $0.
- Modify the form: when a pipeline row already has a saved brief, the button reads **"Open brief"** with a subtle "regenerate" beside it — not "Generate prep brief" (which silently charges you again).

### Phase 2 — The actual prep loop (~1–2 days)

This is what turns a document into a tool. Right now the loop is: generate → read → forget. The engine already supports: generate → **practice** → **debrief** → gaps feed the next brief.

**Files:**
- `web/src/lib/claude-invocation.mjs` — add `interview-practice`, `interview-debrief`, `interview-redflag` to `KNOWN_KINDS`.
- `web/src/lib/run-prompts.mjs` — three new prompt branches, same report-number-or-JSON input convention as the existing two.
- `web/src/app/api/interview/practice/route.ts` — **new**, streaming. **Architecture note:** `api/assistant/route.ts` already does multi-turn by replaying `history.slice(-8)` into a one-shot prompt — stateless, no session management. Practice reuses that exact pattern. No new architecture needed; this was my main risk and it is retired.
- `web/src/components/interview/practice-session.tsx` — **new**. One question at a time, answer box, per-answer scored feedback (`modes/interview/practice.md` already defines the rubric), session summary at the end, writes `interview-prep/sessions/{date}.md`.
- `web/src/components/interview/question-bank.tsx` — **new**. Reads `interview-prep/question-bank.md`. Every question you've ever been asked, tagged 🔴 gap / 🟡 shaky / 🟢 solid, filterable by company and round type. **This is the "here are my role's questions and I can get ready from them" thing you asked for** — and the engine already populates it from debriefs.
- `web/src/components/interview/story-bank.tsx` — **new**. Your STAR stories, editable, with a "which of my stories fits this question" mapper (Step 5 of `interview-prep.md` already produces this table).

### Phase 3 — Growth tab (~2 days)

**Files:**
- `web/src/app/api/growth/route.ts` — **new**. `Promise.all` over the zero-LLM scripts in §1.3, each already emitting JSON. One request, one payload, **$0**.
- `web/src/components/growth/skill-map.tsx` — `upskill.mjs` output as a ranked list: skill, how many roles you lost because of it, weighted urgency. Each gap links to "find a course" (`modes/training.md`) and "log a cert" (`assessment-log.mjs`).
- `web/src/components/growth/funnel-health.tsx` — `funnel-velocity.mjs` + `analyze-patterns.mjs`: your conversion at each stage vs market benchmark, with the honest read ("you convert applications→screen fine; you lose at technical round").
- `web/src/components/growth/comp-position.tsx` — `salary-gap.mjs`: desired vs advertised vs actual, and whether your target is anchored to reality.
- `web/src/components/growth/targeting.tsx` — `modes/titles.md` (adjacent titles from your CV) + remote/geo filters from `config/profile.yml`. Answers "should I switch track", "where are the remote roles".

**Design constraint:** the Growth tab must render fully with **zero LLM calls**. Every LLM action on it is an explicit button with a `<CostBadge>`. A dashboard that costs money to look at is a dashboard nobody looks at.

### Phase 4 — The roadmap layer (deferred, see critique)

A derived quarterly view: *"3 gaps are blocking 12 roles → close Swift first. Your funnel dies at technical round → run 4 practice sessions. Your ask is 15% below advertised median → raise it."* Generated from Phase 3's data, not hand-maintained.

---

## Part 3 — Critique of the above

Written against my own plan. These are the parts I would push back on if someone handed me this.

### C1 — Phase 0 is the only phase with a proven problem. Everything else is a hypothesis.
The user's complaint was concrete and reproducible: the text is unreadable. Phases 2–4 are inferred from "think what features we can add." **Phase 0 must ship and be used for a week before Phase 2 starts.** If Phase 0 alone makes the page usable, Phase 2 may not be worth 2 days.

### C2 — Phase 4 is a to-do list with extra steps.
Every career app builds a "roadmap" and every one of them dies as an abandoned checklist. It only earns its place if it is 100% derived from Phase 3's numbers and cannot be manually edited — the moment you can add your own item it becomes a neglected Notion page. **Recommend: cut Phase 4 from v1 entirely.** Revisit only if the Growth tab actually gets opened.

### C3 — The branch is already too dirty for this.
`feat/web-ui-feature-parity` has 40 modified files and 14 untracked ones, including unrelated extension work. Adding a 20-file feature on top makes the diff unreviewable. **Phase 0 goes on its own branch off `main`.**

### C4 — Streaming markdown is a real trap I glossed over.
"Render markdown when done, tail when running" sounds clean but the handoff will flicker, and a run that errors mid-stream leaves you with neither view. Needs a defined three-state machine (`running` → `done` → `error`), and commit `7047b27` in this repo is literally "replace chat-transcript UI with a real result-card state machine" — **the extension already solved this exact problem. Read that commit before writing Phase 0.**

### C5 — The document outline depends on headings the mode file only *mostly* guarantees.
`modes/interview-prep.md` defines its output template, but LLM output drifts. An outline built from parsed `##` headings will occasionally be empty or wrong. Needs a fallback: no headings parsed → no rail, full-width document, no crash. Do not make the outline load-bearing.

### C6 — "Studio" adds a nav rename to a UI the user already finds confusing.
Renaming `/interview` risks breaking existing links and muscle memory for a cosmetic gain. **Keep the route `/interview`, keep the nav label "Interview", add the Growth tab inside it.** Rename later if it earns it, or give Growth its own nav entry — that decision is cheap to defer and expensive to get wrong twice.

### C7 — Practice mode has a quality risk the plan understates.
Replaying 8 messages of history works for a chat advisor. A 45-minute technical interview with 12 questions and per-answer feedback will exceed that window, and the interviewer will start forgetting your earlier answers — which is the single most immersion-breaking failure possible for this feature. Mitigation: persist the transcript to `interview-prep/sessions/` **as it goes**, and replay a compacted summary rather than raw turns. This is real work and Phase 2's estimate should be 2–3 days, not 1–2.

### C8 — I have not verified `salary-gap.mjs`, `funnel-velocity.mjs`, or `analyze-patterns.mjs` actually run on this user's data.
I verified `upskill.mjs` (works, 29 reports) and `weekly-digest.mjs` (works, empty — no sessions recorded yet). The others are assumed. **Phase 3 needs a 15-minute spike running each script before any UI is written**, because several depend on `data/status-log.tsv` and `data/active-interviews.md` which may be sparse. A Growth tab that renders four empty cards is worse than no Growth tab.

### C9 — Cost of the empty state.
With no interviews recorded, Phase 2's question bank and Phase 3's funnel are both empty. The feature only becomes valuable *after* the first debrief. **Every panel needs a designed empty state that teaches the loop**, not a "no data" shrug. This is genuinely half the design work and the plan allocated none of it.

### C10 — What is missing from this plan entirely.
Two things a senior review would flag as absent: (a) **no calendar/date awareness** — "interview Thursday 2pm" should drive the whole page's urgency, and `interview/plan.md` already takes a date input that the UI collects and then does nothing visible with; (b) **no mobile story**, despite a prep brief being a document you read on your phone in a lobby. Phase 0 must be mobile-correct, not desktop-only-and-we'll-fix-it-later.

---

## Part 4 — Recommended cut

| Phase | Verdict |
|---|---|
| **Phase 0** (readability) | **Do now.** Own branch off `main`. Proven problem, small diff, no cost change. |
| **Phase 1** (library) | **Do now**, with Phase 0. It stops you being charged for work already on disk. |
| **Phase 2** (practice/debrief/banks) | **Next**, after a week of using 0+1. Re-estimate at 2–3 days per C7. |
| **Phase 3** (growth) | **After a 15-min spike** (C8). High value, low cost, but unverified. |
| **Phase 4** (roadmap) | **Cut.** (C2) |
