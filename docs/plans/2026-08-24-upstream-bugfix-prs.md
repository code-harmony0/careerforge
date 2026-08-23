# Upstream bug-fix PRs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land the remaining bug fixes that santifer explicitly requested when he closed PR #3043, as separate focused PRs against `santifer/career-ops`, then return to careerforge work.

**Architecture:** Each fix is its own branch off a freshly-fetched `upstream/main`, in the dedicated checkout at `/Users/codeaura/Projects/careerops-pr` — never in the careerforge working tree. One fix per PR, no lockfile churn, nothing riding along. This is the scope discipline whose absence got #3043 closed.

**Tech Stack:** Next.js 16 / React 19 / TypeScript for `web/`, plain `.mjs` + `node:test` for logic, Tailwind v4 for styling, Playwright (`playwright-core`, already a `web/` dependency) for visual verification.

---

## Context: what was asked, and what is actually still possible

santifer closed #3043 on a policy boundary — which CLI modes get a web surface is first-party roadmap, decided in #3045, which is still open with no plan posted. He then named four bugs from that PR and asked for each as a standalone PR.

State verified against `upstream/main` at `10a569b` on 2026-08-24:

| # | Fix | Home upstream? | Status |
|---|-----|----------------|--------|
| 1 | `language.modes_dir` write-only | yes | **DONE — PR #3253 open** |
| 2 | Report tables crushed at `max-w-3xl` | yes | still broken — Task 1 below |
| 3 | contacto searches 4–5 targets, uses 1 | yes, in `modes/contacto.md` | still broken — Task 2 below |
| 4 | LocationSettings / MarketSettings a11y | **NO** | **cannot be sent** — see below |

### Why fix 4 cannot be sent

`web/src/components/location-settings.tsx` and `web/src/components/market-settings.tsx` **do not exist on `upstream/main`**. Both were new files introduced by #3043, and #3043 was closed. There is no upstream component to make accessible.

Verified: `git cat-file -e upstream/main:web/src/components/location-settings.tsx` → absent; same for market-settings.

santifer listed it in good faith while reading a 1,406-line diff; the a11y issues were real, but they were in code that never landed. **Do not open a PR for this.** If the a11y work is wanted upstream it has to wait for those components to exist, which is gated on #3045. Worth one sentence on #3043 so it is not left looking ignored.

### Fix 3's real location

Santifer said "if you can lift it out of the mode-surface changes, send it." It lifts cleanly, because the waste is in the CLI mode file, not only in the web prompt: `modes/contacto.md` Step 1 instructs the agent to identify a hiring manager, a recruiter, 2–3 peers and an interviewer — 4–5 WebSearch targets — and Step 3 then selects exactly **one** primary target. The other searches are paid for and discarded, on every run, in the CLI too.

The web prompt this was originally fixed in (`run-prompts.mjs`'s contacto branch) does not exist upstream — `grep -c contacto web/src/lib/run-prompts.mjs` on `upstream/main` returns 0. So the mode file is the only correct home, and it is a better one.

---

## Task 1: Report tables get room to breathe

**Files:**
- Modify: `web/src/components/report-view.tsx:71` (the `max-w-3xl` page container)
- Modify: `web/src/components/report-view.tsx` (add a `components` prop to the `ReactMarkdown` calls)
- Modify: `web/src/app/jobs/[id]/page.tsx:19` and `:31` (`max-w-3xl`)

**Why:** an A–F evaluation table runs 5–7 columns of real prose. At 768px each cell collapses to roughly one word per line. `report-view.tsx` currently passes **no** `components` prop to any of its seven `ReactMarkdown` calls, so tables render unwrapped and set the page's minimum width.

**Step 1: Confirm the current state**

Run:
```bash
cd /Users/codeaura/Projects/careerops-pr
git fetch upstream --quiet && git checkout -q -b fix/web-report-table-width upstream/main
grep -n 'max-w-3xl' web/src/components/report-view.tsx web/src/app/jobs/\[id\]/page.tsx
grep -c 'overflow-x-auto' web/src/components/report-view.tsx
```
Expected: three `max-w-3xl` hits; `0` for `overflow-x-auto`.

**Step 2: Capture the "before" evidence**

Start the dev server, open a report at 1440px and 390px, screenshot both. There is no unit test that can assert a Tailwind class is *readable* — the honest verification here is visual, and the PR needs before/after images anyway. Save to the scratchpad, not the repo.

**Step 3: Add the table container**

Define one `Components` map and pass it to every `ReactMarkdown` call in the file. Give the table its own horizontal scroll rather than widening the page — the prose column must stay at a readable measure:

```tsx
const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px]">{children}</table>
    </div>
  ),
};
```

**Step 4: Widen the page containers**

`max-w-3xl` → `max-w-4xl` in `report-view.tsx:71` and both sites in `jobs/[id]/page.tsx`. Do NOT go wider: past ~4xl the prose measure gets too long to read comfortably, and the scroll container already solves the table.

**Step 5: Verify the page cannot overflow horizontally**

At 390px, `document.documentElement.scrollWidth` must equal `clientWidth`. This is the check that catches a table escaping its container.

Run (Playwright, from `web/`): navigate to a report at 390×844, assert `scrollWidth === clientWidth`.
Expected: equal.

**Step 6: Full verification**

```bash
cd /Users/codeaura/Projects/careerops-pr/web && npm test && npx tsc --noEmit && npm run build
cd /Users/codeaura/Projects/careerops-pr && node test-all.mjs
```
Expected: web 342 pass / 0 fail; tsc exit 0; build compiled; root 5310 pass / 0 fail.

**Step 7: Commit and open the PR**

```bash
git add web/src/components/report-view.tsx "web/src/app/jobs/[id]/page.tsx"
git commit   # message: what changed, why 4xl not wider, why the table scrolls instead
git push -u origin fix/web-report-table-width
gh pr create --repo santifer/career-ops --base main --head code-harmony0:fix/web-report-table-width
```

PR body must include the before/after screenshots at both widths, and state that no unit test is offered because a Tailwind class's readability is not unit-testable — the mobile `scrollWidth` assertion is what is mechanically checkable.

---

## Task 2: contacto stops paying for searches it discards

**Files:**
- Modify: `modes/contacto.md` (Step 1 of the "LinkedIn power move" variant, around line 22)

**Why:** Step 1 lists 4–5 target types to find via WebSearch; Step 3 picks one. Token cost is santifer's stated #1 theme, and this is pure waste on every single run.

**Step 1: Branch fresh**

```bash
cd /Users/codeaura/Projects/careerops-pr
git checkout -q main && git fetch upstream --quiet
git checkout -q -b fix/contacto-search-ceiling upstream/main
sed -n '20,35p' modes/contacto.md
```

**Step 2: Rewrite Step 1 as a stop-early search**

Keep the persona list — it is still the right set of *candidates* — but make the search ordered and bounded, and stop at the first confirmed useful target. Preserve the existing behaviour that a target which cannot be confirmed is stated plainly rather than guessed.

The instruction must be explicit that the ceiling is a hard limit, not a suggestion, and that finding one good target is success rather than a partial result. Roughly: try the hiring manager first (usually the strongest primary at this stage), fall back to a recruiter or peer only if that comes up empty, stop the moment there is one confirmed target, and treat 3 WebSearch calls as a hard ceiling.

**Step 3: Confirm nothing else in the mode depends on a full roster**

```bash
grep -n 'targets\|roster\|all contacts\|each persona' modes/contacto.md
```
Read every hit. Step 3 ("Select primary target") and Step 4 ("Generate message") must still make sense with one target. If any later step assumes a list, that step needs adjusting in the same commit or the change is incoherent.

**Step 4: Verify the suite still passes**

```bash
cd /Users/codeaura/Projects/careerops-pr && node test-all.mjs
```
Expected: 5310 pass / 0 fail. The suite has guards that read mode files (`tests/updater-upgrade-safety.test.mjs`, and `test-all.mjs` reads `modes/` for its coverage and personal-data checks), so a malformed edit will surface here.

**Step 5: Commit and open the PR**

Explain the arithmetic in the body: 4–5 searches performed, 1 result used, on every run. Note explicitly that this is the CLI mode file and therefore touches no web surface — that is the whole reason it is sendable.

---

## Task 3: Close the loop on fix 4

**Files:** none.

Post one short comment on #3043 stating that the LocationSettings/MarketSettings a11y fixes have no upstream target because both components were introduced by that PR and do not exist on `main`, and that they can follow once #3045's plan lands. Do not open a PR.

This costs nothing and prevents the fourth item looking silently dropped.

---

## Task 4: Switch back to careerforge

Once Tasks 1–3 are sent:

```bash
cd /Users/codeaura/Projects/career-ops && git switch main && git status
```

The upstream checkout at `/Users/codeaura/Projects/careerops-pr` stays where it is — it is the working reference for any review feedback on #3253 and the two new PRs. Do not delete it while PRs are open.

Then resume the careerforge queue, in this order:

1. **Fix `mergeSection`'s duplicate-heading bug** (`web/src/lib/interview-paths.mjs`). It matches on an exact heading, so a second save whose body carries its own headings appends instead of replacing — the Qrusible brief already has `Step 5 — Story Bank Mapping` at lines 207 and 280. This blocks harvesting questions out of saved briefs, because the harvester would import every duplicated section twice.
2. **The LLM half of the answer coach** — "draft one from my CV" and the scored rubric rewrite, on top of the free analysis pass that already ships.
3. **Rebrand the remaining upstream references** — `SUPPORT.md` still points at santifer's Discord, and there is no CONTRIBUTING guide naming code-harmony0. Both matter before sharing the repo link.

---

## Rules for every task in this plan

- **Branch from a freshly fetched `upstream/main`, every time.** Upstream is 142+ commits ahead of careerforge main. Branching from the wrong base is what produced #3043's 333-file conflict.
- **One fix per PR.** No opportunistic cleanups, no drive-by refactors.
- **Revert lockfile churn** before committing: `npm install` rewrites `web/package-lock.json` and it must not appear in the diff.
- **Never push careerforge work upstream.** The PR checkout is a separate clone precisely so this cannot happen by accident.
- **Verify before claiming** (@superpowers:verification-before-completion): run the command, read the counts, then state the result.
