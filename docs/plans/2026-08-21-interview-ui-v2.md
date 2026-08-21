# Interview UI v2 — Pipeline picker, paste-a-link, history, dedup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user prep for interviews without manual data entry — pick a job already in their pipeline, or paste a link and let it evaluate-then-prep automatically — see their prep history, and avoid the AI re-asking questions it already asked them.

**Architecture:** Reuse what exists rather than add new endpoints. `/api/pipeline` already returns `{applications}` (company/role/report# for everything tracked) — the pipeline picker just fetches it. `useJobs()` already persists every run to localStorage — history is a filtered view of `jobs`, no new storage. `buildPrompt` gains a second input shape (bare report number, same convention `cover`/`deep`/`training` already use) alongside the existing manual-entry JSON shape, so pipeline-pick and paste-a-link both just produce a report number and reuse the same prompt path.

**Tech Stack:** Same as the rest of `web/` — Next.js/TypeScript for UI, plain `.mjs`+`node:test` for prompt logic.

---

## Task 1: Report-number input + question-bank dedup

**Files:**
- Modify: `web/src/lib/run-prompts.mjs`
- Test: `web/tests/lib/run-prompts.test.mjs`

**What:**

In the `interview-prep`/`interview-plan` branch of `buildPrompt`, before the existing `safeParseJson(input)` call, check if `input` is a bare report number (`/^\d+$/.test(input)`). If so, build a report-grounded variant of the prompt: tell the agent to read `reports/${input}-*.md` for company/role/JD context (same phrasing pattern `deep`'s prompt already uses for `reports/${input}-*.md`), and skip the "(company not given)" placeholder logic entirely — the report supplies it. If `input` is NOT a bare number, keep the existing JSON-parse path unchanged (manual entry still works exactly as before).

Also: the `interview-prep` branch currently only reads `interview-prep/story-bank.md`. Add `interview-prep/question-bank.md` to its read list (interview-plan already reads it) and add one instruction line: don't re-ask a question already marked covered/attempted in that file — surface it as "already asked" context instead of a fresh question.

**Step 1: Write the failing tests**

Add to `web/tests/lib/run-prompts.test.mjs`:

```javascript
test("buildPrompt: interview-prep accepts a bare report number and reads the report directly", () => {
  const prompt = buildPrompt({ kind: "interview-prep", input: "042", memory: "", today: "2026-08-04" });
  assert.match(prompt, /reports\/042-\*\.md/);
  assert.match(prompt, /modes\/interview-prep\.md/);
});

test("buildPrompt: interview-plan accepts a bare report number and reads the report directly", () => {
  const prompt = buildPrompt({ kind: "interview-plan", input: "042", memory: "", today: "2026-08-04" });
  assert.match(prompt, /reports\/042-\*\.md/);
  assert.match(prompt, /modes\/interview\/plan\.md/);
});

test("buildPrompt: interview-prep still supports manual JSON input (no report number)", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer" });
  const prompt = buildPrompt({ kind: "interview-prep", input, memory: "", today: "2026-08-04" });
  assert.match(prompt, /Acme Corp/);
  assert.ok(!/reports\//.test(prompt) || prompt.includes("interview-prep.md"), "manual path must not require a report file");
});

test("buildPrompt: interview-prep reads question-bank.md and avoids re-asking covered questions", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer" });
  const prompt = buildPrompt({ kind: "interview-prep", input, memory: "", today: "2026-08-04" });
  assert.match(prompt, /question-bank\.md/);
  assert.match(prompt, /don't re-ask|never re-ask|avoid re-asking/i);
});
```

**Step 2: Run tests, verify they fail**

`cd web && node --test tests/lib/run-prompts.test.mjs` — the report-number tests fail (falls through to manual/evaluate-fallthrough path today); the question-bank test fails for `interview-prep` (only `interview-plan` reads it today).

**Step 3: Implement**

Read the current `interview-prep`/`interview-plan` branch in `run-prompts.mjs` first (it's the code Task 2 of the prior plan added) before editing — match its existing voice/structure. Add the report-number branch and the question-bank.md read line. Keep every existing behavior (manual JSON path, VERDICT line, mem/concise directives) unchanged.

**Step 4: Run tests, verify pass. Run the FULL suite** (`cd web && npm test`) to confirm no regression in the 278 existing tests.

**Step 5: Commit**

```bash
cd web && git add src/lib/run-prompts.mjs tests/lib/run-prompts.test.mjs
git commit -m "feat(web): interview-prep/plan accept a report number, dedup via question-bank.md"
```

---

## Task 2: Pipeline picker, paste-a-link chaining, history list

**Files:**
- Modify: `web/src/components/interview/interview-form.tsx`

**What:** Restructure the form into three input modes (tabs or a simple mode toggle — implementer's call on the exact UI, keep it simple):

1. **From pipeline** — on mount, `fetch("/api/pipeline")`, list `applications` (company, role, tracker `n`) in a searchable dropdown/list. Picking one sets `input = app.n` (the bare report number) and calls `startJob` with `kind: "interview-prep"` or `"interview-plan"` same as today's buttons, using `app.company`/`app.role` for the job title/subtitle and for the eventual Save call.
2. **Paste a link** — a URL input + a single "Prep for this" button. On click: `startJob({kind: "evaluate", input: url, ...})`. Poll/watch that job (same `jobs` array from `useJobs()`) until `status === "done"`; read its `reportNum`. Re-fetch `/api/pipeline`, find the application matching that report number for company/role, then automatically `startJob({kind: "interview-prep", input: reportNum, ...})` (default to prep; a plan-vs-brief choice can reuse the existing two buttons once a report number is available — implementer's call on exact sequencing, but the end state is: paste link → see evaluation → see prep brief, no extra manual steps). Show both jobs' progress, not just the final one.
3. **Manual** — today's existing company/role/JD/date form, unchanged, as a fallback for a role not yet evaluated.

**History list:** below the input modes, render a "Recent prep" section: `jobs.filter(j => j.kind === "interview-prep" || j.kind === "interview-plan").slice(0, 10)`, each showing subtitle + relative date + a "View" click that sets `activeJobId` to that job's id (reusing the existing results panel — no new display logic needed, it already renders whatever `activeJob` points at).

**Save button behavior:** must keep working for all three modes — the `savedFor` snapshot pattern already in the file (captured at `startJob` time) already generalizes: for pipeline-pick and paste-link modes, snapshot `{company, role}` from the resolved application data at the moment `interview-prep`/`interview-plan`'s `startJob` fires, same as manual mode does today.

**No test file for this task** — it's a UI component; verify via `npx tsc --noEmit` and a manual/Playwright pass (same approach Task 7 of the prior plan used): confirm the three modes each produce a correctly-shaped `startJob` call (report number for pipeline/paste-link, JSON for manual), confirm the evaluate→prep chain actually fires the second job once the first completes, confirm the history list renders and clicking an entry shows its saved output, confirm Save still works from each mode.

**Step 1:** Read the current `interview-form.tsx` in full first — this task extends it, not rewrites it from scratch. Read `web/src/components/jobs/job-store.tsx`'s `Job`/`useJobs` types again (chaining a second job off a first job's completion is new — trace how `jobs` updates via `patch`/`setJobs` to know how to watch for `status === "done"` from a React effect, e.g. `useEffect` keyed on the evaluate job's id and status).

**Step 2:** Implement the three modes + history list + chaining, per the description above. Use existing Tailwind conventions from the current file.

**Step 3:** `cd web && npx tsc --noEmit` — clean.

**Step 4:** Manual/Playwright verification per the bullet list above. Clean up any test artifacts (saved files, forced localStorage state).

**Step 5: Commit**

```bash
cd web && git add src/components/interview/interview-form.tsx
git commit -m "feat(web): pipeline picker, paste-a-link auto-chaining, and prep history on /interview"
```

---

## Not building (explicitly out of scope)

- **Upstream career-ops merge tooling**: this is a git workflow question, not a feature — keep this work on its own branch and rebase it on top when upstream career-ops publishes updates, rather than building any tooling for it.
- **URL-to-existing-report dedup** before paste-a-link's evaluate call: no existing matcher for this in the codebase, and evaluate is cheap enough to just re-run; skip inventing one now, add later if it's actually annoying in practice.
