# Interview prep, part 2: a question bank, tech questions, and an answer coach

> **Status:** PROPOSAL. Nothing implemented. Read the Critique before starting.
> **Predecessor:** `docs/plans/2026-08-23-career-studio.md` (Phase 0 + 1 shipped: the reader and the saved-brief library).
> **For Claude:** when approved, use `superpowers:executing-plans`, phase by phase.

---

## Part 1 — How questions are found today, and why that's the whole problem

### 1.1 The mechanism

There is exactly one source of interview questions in this system: **Step 4 of `modes/interview-prep.md`**, which runs fresh every time you press "Generate prep brief".

On each run the agent:

1. Web-searches the company's hiring process (Step 1) — Glassdoor, Blind, engineering blogs, ATS pages.
2. Reads the job description out of `reports/{NNN}-*.md`.
3. Reads `cv.md`, `config/profile.yml`, `modes/_profile.md`, `interview-prep/story-bank.md`.
4. Emits questions **grouped by audience** — `recruiter-screen`, `hiring-manager`, `peer-tech`, `panel-mixed` — each tagged either with a citation or `[inferred from JD]`. Fabrication is explicitly forbidden.

The output is good. The Qrusible brief on disk has four rounds and roughly thirty questions with per-audience framing and a `[inferred from JD]` tag on each.

### 1.2 Why it doesn't add up to a prep tool

**The questions are generated and then thrown away.** They exist as prose inside one 33KB markdown blob per company. Nothing indexes them, nothing tracks which you have practised, nothing carries them to the next company.

**`interview-prep/question-bank.md` does not exist.** Confirmed: `interview-prep/` holds one saved brief, `sessions/`, and a `.gitkeep`. Every interview mode reads the question bank — `plan.md`, `practice.md`, `debrief.md`, and the web's own `run-prompts.mjs` all instruct the agent to consult it and never re-ask a covered question. But the only writer is `modes/interview/debrief.md` Step 3, and debrief has never run. So the deduplication those files describe has never once happened.

**There is no tech axis.** `peer-tech` questions are generated *per company, from that company's JD*. Nothing knows that React Native, NestJS and system design are your stack independent of who is hiring. Every company pays to rediscover the same "explain the bridge vs JSI" question from scratch.

**Nothing accepts your answer.** You can read a suggested answer. You cannot write one, store it, or have it checked.

### 1.3 The engineering insight this plan is built on

A question has **three independent axes**, and today all three are flattened into one document:

| Axis | Example | Reusable across | Cost to produce |
|---|---|---|---|
| **Company** | "Qrusible runs a Q-Factor technical vetting round" | nothing | expensive — needs web research |
| **Role / archetype** | "How do you scope a greenfield mobile product?" | every senior full-stack role | cheap — generated once per archetype |
| **Tech / stack** | "How do you diagnose a Hermes bundle-size regression?" | every company using React Native | **free** — open-source packs |

Separate them and the economics invert. Tech questions get seeded from public repos at zero cost. Role questions are generated once and reused across your whole pipeline. Only the thin company layer stays expensive, and it is the only layer that genuinely has to be.

That is the difference between paying per company and paying once.

---

## Part 2 — What other products do (researched, not assumed)

Via Firecrawl, 2026-08-24. Four distinct product categories get lumped together as "AI interview prep": **research** tools, **practice** tools, **resume** tools, and live **copilots**. This project is the first two; copilots are out of scope on ethics grounds and the ethics section of `AGENTS.md` already rules them out.

| Product | The feature worth taking | Verdict |
|---|---|---|
| **Big Interview** | *Answer Builder* — walks you through STAR step by step, plus a question bank filterable by industry and role | **Take.** We already have STAR+R in `story-bank.md`; what's missing is the guided composer and the filterable bank. |
| **Google Interview Warmup** | *Insights* — after an answer: job-related terms you used, your most-used words (catches repetition), and whether you hit expected talking points | **Take.** Deterministic, zero-LLM, runs before any model is called. Highest value per token in this whole plan. |
| **Yoodli** | Filler-word and pacing analysis on spoken delivery | **Take the text half.** Filler words, hedging, sentence length and reading time are free to compute. Audio is out of scope. |
| **Glassdoor / Blind / InterviewDB / LeetCode company tags** | Crowdsourced real questions per company | **Already have it** — Step 1 web-searches these. What's missing is *storing* what it finds instead of discarding it. |
| **sudheerj/reactjs-interview-questions** (44.7k stars), **yangshun/tech-interview-handbook** (~40k), **front-end-interview-handbook**, **DopplerHQ/awesome-interview-questions** | Large, curated, openly-licensed tech question sets | **Take.** This is the answer to the missing tech axis, and it costs nothing. |
| **Pramp / Exponent** | Free peer-to-peer human mocks | Not applicable — needs other humans. |
| Everyone | Spaced repetition on questions you got wrong | **Nobody does this well.** The bank already carries ✅/🟡/🔴 status per question. A due-for-review queue is nearly free and is the one genuinely differentiating idea here. |

---

## Part 3 — The build

### Phase A — The bank itself (foundation, everything else depends on it)

**`interview-prep/question-bank.md`** — a markdown table, matching how `data/applications.md` already works: readable by a human, parseable by a script, diffable in git.

```markdown
| ID | Question | Axis | Tag | Round | Source | Status | Answer | Asked | Last |
|----|----------|------|-----|-------|--------|--------|--------|-------|------|
| q001 | Explain the bridge vs JSI in React Native | tech | react-native | peer-tech | pack:react-native | 🟡 | a001 | 2 | 2026-08-20 |
| q002 | Walk me through the Zonesso 0.75→0.81 upgrade | company | qrusible | peer-tech | inferred-from-jd | 🔴 | — | 0 | — |
```

- `Axis` is one of `tech` / `role` / `company` / `behavioural` — the three-axis split from §1.3, plus behavioural.
- `Status` reuses the ✅ 🟡 🔴 vocabulary `debrief.md` already defines. `new` for unpractised.
- `Answer` points into `interview-prep/answers/{id}.md` so the table stays narrow.
- `Asked` counts real occurrences across companies. A question asked in three loops is not a question you can leave 🔴.

**Files:**
- `question-bank.mjs` — the only writer. `add` / `list` / `status` / `due`, JSON or `--summary`, atomic write plus lock, exactly like `set-status.mjs`. Zero LLM.
- `web/src/lib/question-bank.mjs` — parser shared by the API and the scripts, `node:test` covered.
- `web/src/app/api/questions/route.ts` — GET list with filters, PATCH status.

### Phase B — Filling it, three ways, cheapest first

**B1. Tech packs (free, no LLM, no scraping).** Vendor curated question sets into `templates/question-packs/{tech}.md` — `react-native.md`, `javascript.md`, `node-nestjs.md`, `system-design.md`, `sql.md`, `typescript.md`. Sourced from the openly-licensed repos in Part 2, attributed in a header, refreshed manually not scraped live.

`node question-bank.mjs seed --stack react-native,typescript,node-nestjs` imports them. Stack is read from `config/profile.yml` so the default needs no arguments.

**This is the tech-question feature that was missing, and it costs nothing to run.**

**B2. Harvest from briefs you already paid for.** Every generated brief contains ~30 questions that currently die inside the prose. One parse pass over Step 4's per-audience sections pulls them into the bank, tagged `company:{slug}` with their citation. No new LLM call — the text is already on disk. Runs automatically on save.

**B3. Debrief (already specified, never wired).** `modes/interview/debrief.md` Step 3 already describes updating the bank from a real interview. Wire it to `question-bank.mjs` so it stops being a promise.

### Phase C — The answer coach

Two directions, one screen.

**C1. "Draft one for me."** Given a question, produce an answer using the Headline / Effect / Rationale / Operations frame that `interview-prep.md` already defines, grounded strictly in `cv.md`, `article-digest.md`, `story-bank.md`, `_profile.md`. Saved to `interview-prep/answers/{id}.md`.

**C2. "I wrote one, fix it."** You type. Two passes:

*Pass one is free and runs first.* No model involved:
- word count and spoken reading time (a 4-minute answer to a screener question is the actual problem, and no LLM is needed to notice)
- filler and hedge density — "basically", "kind of", "I guess", "sort of"
- STAR/HERO structure detection: does it open with a result or wander in?
- **CV keyword overlap** — which of your real technologies and achievements appear. This is the Interview Warmup steal.
- repetition: your top words, so you can hear yourself say "basically" nine times

*Pass two costs a run* and gives the scored rubric from `modes/interview/practice.md`, plus a rewrite.

**C3. The grounding gate — the part that matters most.** `AGENTS.md`'s Source-of-Truth Boundary forbids inventing claims about you. So the coach must do something no competitor does: **flag any factual claim in your answer that is not backed by `cv.md` or `story-bank.md`.**

Not a limitation. The single most valuable output here is: *"you said you 'led a team of six' — that number appears nowhere in your CV. Either it's real and belongs in your CV, or you're about to say it out loud to a hiring manager who will ask a follow-up."* Every other tool in Part 2 will happily help you rehearse something you cannot defend.

### Phase D — Practice and the drill queue

- **Practice run**: one question at a time, optional timer, textarea, submit, feedback, status updates in the bank. Wires up `modes/interview/practice.md`, which the web has never exposed. Multi-turn works the way `api/assistant/route.ts` already does it (replay recent history into a one-shot prompt); no new architecture.
- **Due queue**: 🔴 first, then 🟡 not seen in 14 days, then high `Asked` counts. Plain date arithmetic, no LLM, and nobody else in this space ships it.

### Phase E — UI

`/interview` gains a third tab, **Question bank**.

- Filter chips across the top: the three axes plus behavioural, then company, then status. Search box.
- List rows: question, axis chip, company chip, status dot, whether an answer exists.
- Click a row for a detail pane: the question, its source, your saved answer, the free analysis, and the two coach buttons with cost badges.
- A **Drill** button on the header runs the due queue full-screen, one question at a time.

Design constraint carried from the last plan: **the bank renders with zero LLM calls.** Every model call is a button you press, with a cost badge on it.

---

## Part 4 — Critique of the above

### C1. Phase B1 has a licensing question I have not answered.
"Openly licensed" is my assumption, not a checked fact. `sudheerj/reactjs-interview-questions` and `tech-interview-handbook` need their actual LICENSE files read before a single question is vendored into this repo. If a pack is not redistributable, it becomes a *link out*, not a bundled file. **Check licences before writing any pack. This is the one blocking item in the plan.**

### C2. The three-axis split is the good idea here, and it's also the risky one.
Classifying a question as tech vs role vs company is a judgement call, and the harvester in B2 will get it wrong sometimes. A misfiled question is a question you never see again. Mitigation: the axis is editable in the UI, and B2 defaults to `company` (the safest wrong answer, since it stays attached to the company you generated it for).

### C3. Phase A's file is user-layer and gitignored.
`.gitignore` lines 44 to 46 exclude `interview-prep/*`. That's correct for privacy, but it means the bank has no version history and a bad write is unrecoverable. `question-bank.mjs` must be the sole writer, must write atomically, must take the shared lock, and should keep one `.bak`. Do not let modes hand-edit it.

### C4. C3's grounding gate will produce false positives, and false positives here are expensive.
Keyword matching against `cv.md` will flag legitimate paraphrase as unsupported. Told bluntly, that trains you to ignore the warning, which destroys the feature. It must be phrased as a question ("is this in your CV?") with a one-click "yes, add it to my CV" path, never as an accusation.

### C5. I am proposing five phases again, and I cut a fifth phase last time for exactly this reason.
Phase A plus B1 alone is a usable product: a filterable bank with real tech questions in it, for zero running cost. **Ship that, use it for a week, then decide.** C and D are considerably more work and are worth nothing if the bank turns out to sit unopened.

### C6. Reading time is not speaking time and I nearly conflated them.
People speak at roughly 130 to 150 words per minute, well below silent reading speed. Getting this wrong makes every length warning wrong. Use a speaking rate, state the assumption on screen.

### C7. The duplicate-section bug from the last review is still open and this plan makes it worse.
`mergeSection` matches on an exact heading, so the Qrusible file already contains `Step 5 — Story Bank Mapping` twice. B2 parses saved briefs. It will happily harvest both copies and produce duplicate bank entries. **Fix `mergeSection` before B2 ships**, not after.

### C8. What is still missing from this plan.
No mock-interview *scheduling* against a real interview date, though `interview/plan.md` already accepts a date the UI collects and ignores. No export, and a question bank you cannot print is one you cannot revise on the train. And nothing here helps with take-home assignments, which for a senior full-stack role are at least as common as a live technical round.

---

## Part 5 — Recommended cut

| Phase | Verdict |
|---|---|
| **A** — the bank, script, API | **Do first.** Everything depends on it. Zero running cost. |
| **B1** — tech packs | **Do first, after the licence check (C1).** This is the missing tech-question feature and it is free. |
| **B2** — harvest existing briefs | **Do second**, after `mergeSection` is fixed (C7). Recovers questions already paid for. |
| **C** — answer coach | **Next.** Start with the free analysis pass; it is most of the value at none of the cost. |
| **D** — practice and drill queue | **After** a week of real use. |
| **B3, E** — debrief wiring, full UI | Fold into whichever phase needs them. |
