# Interview Prep in the Web UI — v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add company-specific interview prep briefs, time-blocked prep plans, and negotiation/offer-prep walkthroughs to the career-ops web app, as three new one-shot worker kinds plus a small `/interview` page.

**Architecture:** Reuse the existing worker-kind pattern end-to-end — `buildPrompt` gets three new branches, the agent runs read-only (no Write/Bash, matching every other draft-producing kind), and a new backend-owned save route writes the finished output to `interview-prep/{company}-{role}.md` (the agent never writes this file itself — same "backend is the only writer" rule the PDF flow already enforces). No new streaming infrastructure: the page reuses `useJobs()`/`startJob` exactly like `TrainingEvaluate` does.

**Tech Stack:** Next.js (App Router) + TypeScript for routes/pages, plain `.mjs` + `node:test` for the testable logic modules (this repo's established split — see `web/README.md` → Tests).

**Design doc:** `docs/plans/2026-08-20-interview-web-ui-design.md`

---

## Before you start

Read these once, in this order, so the "why" behind each step below isn't a mystery:

- `web/src/lib/run-prompts.mjs` — the exact shape every kind's prompt follows (VERDICT line, `mem`/`concise` directives, DRAFT-ONLY wording for kinds like `cover`).
- `web/src/lib/claude-invocation.mjs` — why every write-capable tool is explicitly denied, not just omitted.
- `web/src/lib/pdf-paths.mjs` — the `slugify()` helper you'll reuse, and the "pure function + thin route wrapper" split this plan follows for the new save logic.
- `web/src/components/training-evaluate.tsx` — the exact `startJob(...)` pattern the new page's form reuses.
- `modes/interview-prep.md`, `modes/interview/plan.md`, `modes/offer-prep.md` — the real modes these kinds run. You do not need to read them end-to-end; you need to know they exist and what their Inputs sections expect.

**Important asymmetry to keep in mind while implementing:** `offer-prep.md` explicitly states it "never evaluates [clauses] with severity ratings, scores, or verdicts" — but every web kind ends with a numeric `VERDICT: {n}/5` line that `job-store.tsx`'s regex requires to render a result badge. Task 2's offer-prep prompt resolves this by scoring **how complete/ready-to-discuss the walkthrough is**, never the contract's merits — same move already used for `cover`/`email` ("how ready-to-send this draft is"). Don't let the offer-prep prompt drift into rating the offer itself.

Also: `cover.md` and `offer-prep.md` both have interactive checkpoints (confirmations, clarifying questions) that make sense in a live CLI session but not in a headless web run. The `cover` kind's prompt already handles this — it tells the agent to skip the checkpoints and flag assumptions instead. The offer-prep prompt in Task 2 does the same for offer-prep's extraction gate / promises intake / language gate.

---

## Task 1: `interview-paths.mjs` — pure path/content logic for saving

**Files:**
- Create: `web/src/lib/interview-paths.mjs`
- Test: `web/tests/lib/interview-paths.test.mjs`

This is the testable core of the save route — kept framework-free so `node --test` can exercise it directly, same split as `pdf-paths.mjs`.

**Step 1: Write the failing test**

```javascript
// web/tests/lib/interview-paths.test.mjs
//
// Pure logic for where a saved interview-prep artifact goes and how it merges
// with an existing file. Run: node --test tests/lib/interview-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInterviewPrepPath, mergeSection, SECTION_HEADINGS } from "../../src/lib/interview-paths.mjs";

test("resolveInterviewPrepPath: builds interview-prep/{company}-{role}.md", () => {
  const p = resolveInterviewPrepPath("/root", "Acme Corp", "Staff Engineer");
  assert.equal(p, "/root/interview-prep/acme-corp-staff-engineer.md");
});

test("resolveInterviewPrepPath: slugifies unsafe characters out of company/role", () => {
  // Given input that could otherwise escape interview-prep/ via path traversal
  const p = resolveInterviewPrepPath("/root", "../../etc", "passwd");
  // Then the slug strips everything but [a-z0-9-], so no ".." segment survives
  assert.equal(p, "/root/interview-prep/etc-passwd.md");
  assert.ok(!p.includes(".."));
});

test("resolveInterviewPrepPath: rejects empty company or role", () => {
  assert.equal(resolveInterviewPrepPath("/root", "", "Staff Engineer"), null);
  assert.equal(resolveInterviewPrepPath("/root", "Acme", "   "), null);
});

test("mergeSection: creates a fresh file with a title header when none exists", () => {
  const out = mergeSection(null, "prep-brief", "Acme Corp", "Staff Engineer", "Body text here.");
  assert.match(out, /^# Interview Prep — Acme Corp — Staff Engineer/);
  assert.match(out, /## Prep Brief/);
  assert.match(out, /Body text here\./);
});

test("mergeSection: appends a new section to an existing file", () => {
  const existing = "# Interview Prep — Acme Corp — Staff Engineer\n\n## Prep Brief\n\nOld content.\n";
  const out = mergeSection(existing, "prep-plan", "Acme Corp", "Staff Engineer", "Plan body.");
  assert.match(out, /## Prep Brief/);
  assert.match(out, /Old content\./);
  assert.match(out, /## Prep Plan/);
  assert.match(out, /Plan body\./);
});

test("mergeSection: replaces a section of the same kind instead of duplicating it", () => {
  const existing = "# Interview Prep — Acme Corp — Staff Engineer\n\n## Prep Brief\n\nStale content.\n";
  const out = mergeSection(existing, "prep-brief", "Acme Corp", "Staff Engineer", "Fresh content.");
  const mentions = out.match(/## Prep Brief/g) ?? [];
  assert.equal(mentions.length, 1, "must not duplicate the section heading");
  assert.ok(!out.includes("Stale content."));
  assert.match(out, /Fresh content\./);
});

test("SECTION_HEADINGS: covers all three savable kinds", () => {
  assert.equal(SECTION_HEADINGS["interview-prep"], "Prep Brief");
  assert.equal(SECTION_HEADINGS["interview-plan"], "Prep Plan");
  assert.equal(SECTION_HEADINGS["offer-prep"], "Negotiation");
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && node --test tests/lib/interview-paths.test.mjs`
Expected: FAIL — `Cannot find module '../../src/lib/interview-paths.mjs'`

**Step 3: Write minimal implementation**

```javascript
// web/src/lib/interview-paths.mjs
//
// Where a saved interview-prep/plan/offer-prep artifact goes, and how it merges
// with a file that already exists. Kept plain (no fs, no Next.js) so it can be
// unit-tested directly — same split as pdf-paths.mjs. The route that calls this
// owns fs.readFileSync/writeFileSync; this module only computes strings.
import path from "node:path";
import { slugify } from "./pdf-paths.mjs";

/** Section heading per savable kind — also the merge key mergeSection matches on. */
export const SECTION_HEADINGS = {
  "interview-prep": "Prep Brief",
  "interview-plan": "Prep Plan",
  "offer-prep": "Negotiation",
};

/**
 * Where a saved artifact for this company/role lives. slugify() strips
 * everything but [a-z0-9-], so a crafted company/role string (e.g. "../../etc")
 * cannot escape interview-prep/ — same defense pdf-paths.mjs's resolvePdfPaths
 * relies on for the report-number selector.
 *
 * @param {string} root - careerOpsRoot().
 * @param {string} company
 * @param {string} role
 * @returns {string | null} absolute path, or null if company/role slugify to empty.
 */
export function resolveInterviewPrepPath(root, company, role) {
  const companySlug = slugify(String(company ?? ""));
  const roleSlug = slugify(String(role ?? ""));
  if (!companySlug || !roleSlug) return null;
  return path.join(root, "interview-prep", `${companySlug}-${roleSlug}.md`);
}

/**
 * Merge a new section into an existing file's content (or start a fresh file).
 * Replaces a same-kind section in place rather than duplicating it, so re-saving
 * an updated prep brief doesn't pile up stale copies.
 *
 * @param {string | null} existing - current file content, or null if the file doesn't exist yet.
 * @param {keyof typeof SECTION_HEADINGS} kind
 * @param {string} company
 * @param {string} role
 * @param {string} body - the section's markdown body (no heading).
 * @returns {string} the full file content to write.
 */
export function mergeSection(existing, kind, company, role, body) {
  const heading = SECTION_HEADINGS[kind];
  const section = `## ${heading}\n\n${body.trim()}\n`;
  if (!existing) {
    return `# Interview Prep — ${company} — ${role}\n\n${section}`;
  }
  const headingRe = new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`, "m");
  if (headingRe.test(existing)) {
    return existing.replace(headingRe, section.trimEnd());
  }
  return `${existing.trimEnd()}\n\n${section}`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd web && node --test tests/lib/interview-paths.test.mjs`
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
cd web
git add src/lib/interview-paths.mjs tests/lib/interview-paths.test.mjs
git commit -m "feat(web): add interview-paths.mjs for save-path/section logic"
```

---

## Task 2: Three new `buildPrompt` kinds

**Files:**
- Modify: `web/src/lib/run-prompts.mjs`
- Test: `web/tests/lib/run-prompts.test.mjs`

Inputs for these three kinds are richer than a bare string (company + role + optional JD/date, or company + role + contract text), so `input` is a JSON string the page builds with `JSON.stringify(...)`. `buildPrompt` parses it defensively — a parse failure degrades to treating the raw string as the company name rather than throwing, matching this file's general "never let a malformed input crash the route" posture.

**Step 1: Write the failing tests**

Add to `web/tests/lib/run-prompts.test.mjs` (near the other kind-specific tests):

```javascript
test("buildPrompt: interview-prep runs the real mode and requires cv.md context", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer", jd: "Some JD text." });
  const prompt = buildPrompt({ kind: "interview-prep", input, ...ARGS });
  assert.match(prompt, /modes\/interview-prep\.md/);
  assert.match(prompt, /cv\.md/);
  assert.match(prompt, /Acme Corp/);
  assert.match(prompt, /Staff Engineer/);
});

test("buildPrompt: interview-plan runs the real mode and carries the interview date when given", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer", date: "2026-09-01T15:00" });
  const prompt = buildPrompt({ kind: "interview-plan", input, ...ARGS });
  assert.match(prompt, /modes\/interview\/plan\.md/);
  assert.match(prompt, /2026-09-01T15:00/);
});

test("buildPrompt: interview-plan states no fixed date when omitted, not an invented one", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer" });
  const prompt = buildPrompt({ kind: "interview-plan", input, ...ARGS });
  assert.match(prompt, /no interview date was given/i);
});

test("buildPrompt: offer-prep runs the real mode, skips interactive checkpoints, and never rates the offer", () => {
  const input = JSON.stringify({ company: "Acme Corp", role: "Staff Engineer", contractText: "Base salary: $150,000..." });
  const prompt = buildPrompt({ kind: "offer-prep", input, ...ARGS });
  assert.match(prompt, /modes\/offer-prep\.md/);
  assert.match(prompt, /SKIP/i);
  // Then the VERDICT scores completeness of the walkthrough, not the offer's merit
  assert.match(prompt, /never rate the offer itself/i);
});

test("buildPrompt: interview-prep/interview-plan/offer-prep survive malformed JSON input", () => {
  for (const kind of ["interview-prep", "interview-plan", "offer-prep"]) {
    const prompt = buildPrompt({ kind, input: "not json", ...ARGS });
    assert.ok(prompt.length > 0, `${kind} must not throw on malformed input`);
  }
});
```

Extend the existing "every kind ends with exactly one VERDICT instruction" loop's array:

```javascript
  for (const kind of ["pdf", "research", "evaluate", "fix-portal", "interview-prep", "interview-plan", "offer-prep"]) {
```

**Step 2: Run tests to verify they fail**

Run: `cd web && node --test tests/lib/run-prompts.test.mjs`
Expected: FAIL — new assertions don't match (the three kinds fall through to the evaluate prompt today).

**Step 3: Write the implementation**

In `web/src/lib/run-prompts.mjs`, add three new `if (kind === ...)` branches **before** the final `// evaluate (default)` fallthrough comment (order matters — that fallthrough is what makes an unmatched kind become an evaluate prompt, per the existing "unknown kind falls through to evaluate" test). A good insertion point is right after the `fix-portal` branch you can already see in the file.

```javascript
  if (kind === "interview-prep" || kind === "interview-plan") {
    const { company, role, jd, date } = safeParseJson(input);
    const companyLine = company ? String(company) : "(company not given)";
    const roleLine = role ? String(role) : "(role not given)";
    const jdBlock = jd ? `\n\nJob description:\n${String(jd)}` : "";
    if (kind === "interview-prep") {
      return `You are running the career-ops "interview-prep" mode, headless, on the user's own machine, for ${companyLine} — ${roleLine}. Follow modes/interview-prep.md's steps exactly.

1. Read modes/interview-prep.md, cv.md, config/profile.yml, modes/_profile.md (if present), and interview-prep/story-bank.md (if present) for existing prepared stories.
2. Run its research step (WebSearch) for real, cited company/role intel — sourced questions get a citation, everything else is tagged [inferred from JD] per the mode's own tag conventions. Never invent company intel.
3. Produce the full company research pack, likely-question analysis, and Step 5 story-bank mapping table, per modes/interview-prep.md's structure.${jdBlock}${mem}${concise}

End with EXACTLY one final line: VERDICT: {0-5 how complete this prep pack is}/5 — {the single most important gap to close, ≤12 words}`;
    }
    const dateLine = date ? `Interview date/time: ${String(date)}.` : "No interview date was given — build the plan around a generic 3-hour prep window instead of inventing a countdown.";
    return `You are running the career-ops "interview/plan" mode, headless, on the user's own machine, for ${companyLine} — ${roleLine}. Follow modes/interview/plan.md's steps exactly. ${dateLine}

1. Read modes/interview/plan.md, cv.md, config/profile.yml, modes/_profile.md (if present), interview-prep/story-bank.md (if present), and interview-prep/question-bank.md (if present, for 🔴-flagged gaps that outrank inferred ones).
2. Run its fit assessment, round intelligence, and research-check steps for real — reuse interview-prep/{company-slug}-{role-slug}.md if it exists rather than re-searching.
3. Produce the full time-blocked plan (Step 3) and the 15-minute quick-reference (Step 4), per modes/interview/plan.md's template.${jdBlock}${mem}${concise}

End with EXACTLY one final line: VERDICT: {0-5 how ready this plan makes the candidate}/5 — {the single highest-priority block, ≤12 words}`;
  }
  if (kind === "offer-prep") {
    const { company, role, contractText } = safeParseJson(input);
    const companyLine = company ? String(company) : "(company not given)";
    const roleLine = role ? String(role) : "(role not given)";
    const contractBlock = contractText ? String(contractText) : "(no contract text was provided — say so and stop rather than inventing clauses)";
    return `You are running the career-ops "offer-prep" mode, headless, on the user's own machine, for ${companyLine} — ${roleLine}. This mode PREPARES the candidate for their own decision — it describes clauses in plain English, it NEVER rates them with severity levels, scores, or a recommendation to sign. Follow modes/offer-prep.md's clause taxonomy and structure exactly, but SKIP its interactive checkpoints (the extraction-gate confirmation, the promises-intake question, asking for referenced documents) since no one is present to answer them in a headless run — proceed with your own best-effort read of the pasted text instead, and list any assumption or unconfirmed item in a short "Assumptions" section right after the header. If the contract is not in English, stop per the mode's language gate and say so plainly instead of proceeding.

1. Read modes/offer-prep.md, cv.md, config/profile.yml, and any matching evaluation report/tracker row for company/role context.
2. Run the clause walk (Step 2, describe-don't-judge), consistency check (Step 3), and two-lists output (Step 4: questions for a lawyer, items to raise with the employer) against the contract text below.
3. Never assign a severity rating, a numeric score, or a sign/don't-sign recommendation to any clause — that judgment belongs to the candidate and their lawyer, not this output.

Contract/offer text:
${contractBlock}${mem}${concise}

End with EXACTLY one final line, which scores how COMPLETE and ready-to-discuss this walkthrough is — never rate the offer itself: VERDICT: {0-5 how complete this walkthrough is}/5 — {the single most important thing to raise with a lawyer, ≤12 words}`;
  }
```

Add the small parsing helper near the top of the file, below `isShellSafeCompanyName`:

```javascript
/**
 * Parse a worker `input` that is expected to be a JSON object (interview-prep,
 * interview-plan, offer-prep all pack company/role/etc into one JSON string
 * since buildPrompt's signature only carries one `input` string). Never throws:
 * a malformed/legacy string degrades to `{}` so a bad input produces a
 * best-effort prompt instead of a 500.
 *
 * @param {string} input
 * @returns {Record<string, unknown>}
 */
function safeParseJson(input) {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd web && node --test tests/lib/run-prompts.test.mjs`
Expected: PASS (all tests, including the pre-existing ones — check nothing else regressed)

**Step 5: Commit**

```bash
cd web
git add src/lib/run-prompts.mjs tests/lib/run-prompts.test.mjs
git commit -m "feat(web): add interview-prep, interview-plan, offer-prep worker kinds"
```

---

## Task 3: Register the new kinds as read-only

**Files:**
- Modify: `web/src/lib/claude-invocation.mjs`
- Test: `web/tests/lib/claude-invocation.test.mjs`

`toolScopeFor` already defaults any kind not in `PERSISTING_KINDS` to `TOOL_SCOPES.readOnly` — correct behavior for these three, no code change needed there. The only change is adding them to `KNOWN_KINDS` so the enumeration-based guard tests (`"NO kind leaves a write-capable tool merely unmentioned"`) actually cover them, instead of silently only checking the four kinds that existed before this feature.

**Step 1: Write the failing test**

Add to `web/tests/lib/claude-invocation.test.mjs`:

```javascript
test("KNOWN_KINDS: includes the three interview worker kinds", () => {
  for (const kind of ["interview-prep", "interview-plan", "offer-prep"]) {
    assert.ok(KNOWN_KINDS.includes(kind), `KNOWN_KINDS must list ${kind}`);
  }
});

test("toolScopeFor: the three interview kinds are read-only, same scope as research", () => {
  for (const kind of ["interview-prep", "interview-plan", "offer-prep"]) {
    assert.equal(toolScopeFor(kind), TOOL_SCOPES.readOnly, `${kind} must be read-only`);
  }
});
```

**Step 2: Run test to verify it fails**

Run: `cd web && node --test tests/lib/claude-invocation.test.mjs`
Expected: FAIL — `KNOWN_KINDS` doesn't include them yet (the second test passes already since readOnly is the default, but run it anyway to confirm the first fails).

**Step 3: Write the implementation**

In `web/src/lib/claude-invocation.mjs`, update:

```javascript
export const KNOWN_KINDS = Object.freeze(["pdf", "research", "evaluate", "fix-portal", "interview-prep", "interview-plan", "offer-prep"]);
```

**Step 4: Run test to verify it passes**

Run: `cd web && node --test tests/lib/claude-invocation.test.mjs`
Expected: PASS

**Step 5: Commit**

```bash
cd web
git add src/lib/claude-invocation.mjs tests/lib/claude-invocation.test.mjs
git commit -m "feat(web): register interview kinds in KNOWN_KINDS"
```

---

## Task 4: Route guards — required files and cv.md gate

**Files:**
- Modify: `web/src/app/api/run/route.ts`

No new test file here — `route.ts` itself isn't unit-tested per this repo's convention (see `web/README.md` → "Keep tests out of `src/`"); the logic it calls (`buildPrompt`, `toolScopeFor`) is already covered by Tasks 2–3. This task is a small, direct edit verified manually in Task 8.

**Step 1: Extend `needsScript`**

Find this block in `web/src/app/api/run/route.ts`:

```typescript
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs" };
```

Change it to:

```typescript
  const needsScript: Record<string, string> = {
    evaluate: "modes/oferta.md",
    "fix-portal": "verify-portals.mjs",
    pdf: "generate-pdf.mjs",
    "interview-prep": "modes/interview-prep.md",
    "interview-plan": "modes/interview/plan.md",
    "offer-prep": "modes/offer-prep.md",
  };
```

**Step 2: Extend the cv.md-required gate**

Find:

```typescript
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
```

Change to:

```typescript
  if ((kind === "evaluate" || kind === "pdf" || kind === "interview-prep" || kind === "interview-plan") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
```

`offer-prep` is deliberately **not** added here — per `modes/offer-prep.md`'s own Step 0, it's grounded in the contract text the candidate pastes, not a CV-vs-JD match; the mode itself never lists `cv.md` as a required input.

**Step 3: Verify the file still typechecks**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

**Step 4: Commit**

```bash
cd web
git add src/app/api/run/route.ts
git commit -m "feat(web): gate interview kinds on required mode files and cv.md"
```

---

## Task 5: Save route — backend-owned write

**Files:**
- Create: `web/src/app/api/interview/save/route.ts`
- (Logic already tested in Task 1 via `interview-paths.mjs`)

The agent never gets a write tool for these kinds (Task 3) — this route is the *only* writer, same rule the PDF envelope flow follows. It receives the finished streamed text from the client (which already has it in `job.text`) and writes it itself.

**Step 1: Write the route**

```typescript
// web/src/app/api/interview/save/route.ts
//
// The ONLY writer of interview-prep/{company}-{role}.md for web-triggered runs.
// interview-prep, interview-plan, and offer-prep all run with no Write/Bash tool
// (see claude-invocation.mjs) — the agent's output is data the client already
// has (job.text after a "done" stream); this route just persists it, the same
// division of labor pdf-render.mjs uses for the PDF envelope (#2185).
import fs from "node:fs";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveInterviewPrepPath, mergeSection, SECTION_HEADINGS } from "@/lib/interview-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { company?: string; role?: string; kind?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { company, role, kind, content } = body;
  if (!kind || !(kind in SECTION_HEADINGS)) {
    return Response.json({ error: `kind must be one of: ${Object.keys(SECTION_HEADINGS).join(", ")}` }, { status: 400 });
  }
  if (!content || !content.trim()) {
    return Response.json({ error: "Nothing to save — the run has no output yet." }, { status: 400 });
  }
  const filePath = resolveInterviewPrepPath(careerOpsRoot(), company ?? "", role ?? "");
  if (!filePath) {
    return Response.json({ error: "Company and role are required to save." }, { status: 400 });
  }

  fs.mkdirSync(require("node:path").dirname(filePath), { recursive: true });
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = null;
  }
  const merged = mergeSection(existing, kind, company ?? "", role ?? "", content);
  fs.writeFileSync(filePath, merged, "utf8");

  return Response.json({ ok: true, path: filePath });
}
```

**Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors. If `require("node:path")` looks out of place next to the ESM imports at the top, replace it with a proper `import path from "node:path";` at the top of the file instead — do that; the inline `require` above is only there to keep this plan's diff small, don't ship it that way.

**Step 3: Manual smoke test**

Run the dev server (`cd web && npm run dev`) and:

```bash
curl -s -X POST http://localhost:3000/api/interview/save \
  -H "Content-Type: application/json" \
  -d '{"company":"Acme Corp","role":"Staff Engineer","kind":"interview-prep","content":"Test brief body."}'
```

Expected: `{"ok":true,"path":"…/interview-prep/acme-corp-staff-engineer.md"}`, and the file exists with a `## Prep Brief` section.

**Step 4: Commit**

```bash
cd web
git add src/app/api/interview/save/route.ts
git commit -m "feat(web): add backend-owned save route for interview-prep artifacts"
```

---

## Task 6: Nav entry

**Files:**
- Modify: `web/src/lib/nav-items.ts`

**Step 1: Add the entry**

```typescript
import { LayoutDashboard, Compass, ListChecks, Send, Radar, BarChart3, FileText, Settings, MessageSquare } from "lucide-react";
```

```typescript
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Today", icon: LayoutDashboard },
  { href: "/explore", label: "Explore", icon: Compass, chip: "New" },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/interview", label: "Interview", icon: MessageSquare, chip: "New" },
  { href: "/followups", label: "Follow-ups", icon: Send },
  { href: "/portals", label: "Portals", icon: Radar },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/cv", label: "CV", icon: FileText },
  { href: "/config", label: "Config", icon: Settings },
];
```

**Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

**Step 3: Commit**

```bash
cd web
git add src/lib/nav-items.ts
git commit -m "feat(web): add Interview nav entry"
```

---

## Task 7: The `/interview` page

**Files:**
- Create: `web/src/app/interview/page.tsx`
- Create: `web/src/components/interview/interview-form.tsx`

**Step 1: The page (server component, thin)**

```tsx
// web/src/app/interview/page.tsx
import { InterviewForm } from "@/components/interview/interview-form";

export const dynamic = "force-dynamic";

export default function InterviewPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-lg font-semibold">Interview prep</h1>
      <p className="mt-1 text-sm text-faint">
        Company-specific prep briefs, time-blocked prep plans, and offer/negotiation walkthroughs — run against your real CV and profile.
      </p>
      <InterviewForm />
    </div>
  );
}
```

**Step 2: The form (client component)**

Modeled directly on `training-evaluate.tsx`'s `startJob` usage, extended to three fields, three trigger buttons, and a per-job Save action once a run finishes. Company/role/JD/date live in this component's own state — `startJob` never needs to know them individually, and neither does the save call, since this component still has them in closure when the job finishes.

```tsx
// web/src/components/interview/interview-form.tsx
"use client";

import { useState } from "react";
import { useJobs } from "@/components/jobs/job-store";

type Kind = "interview-prep" | "interview-plan" | "offer-prep";

const KIND_LABEL: Record<Kind, string> = {
  "interview-prep": "Generate prep brief",
  "interview-plan": "Build prep plan",
  "offer-prep": "Walk through offer",
};

export function InterviewForm() {
  const { jobs, startJob } = useJobs();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [date, setDate] = useState("");
  const [contractText, setContractText] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hint, setHint] = useState("");

  const activeJob = jobs.find((j) => j.id === activeJobId);

  function run(kind: Kind) {
    if (!company.trim() || !role.trim()) {
      setHint("Company and role are both required.");
      return;
    }
    if (kind === "offer-prep" && !contractText.trim()) {
      setHint("Paste the offer/contract text to walk through it.");
      return;
    }
    setHint("");
    setSaveState("idle");
    const input =
      kind === "offer-prep"
        ? JSON.stringify({ company, role, contractText })
        : JSON.stringify({ company, role, jd: jd || undefined, date: kind === "interview-plan" ? date || undefined : undefined });
    const id = startJob({ title: KIND_LABEL[kind], subtitle: `${company} — ${role}`, kind, input, page: "/interview" });
    setActiveJobId(id);
  }

  async function save() {
    if (!activeJob || !activeJob.kind || activeJob.status !== "done") return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/interview/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, role, kind: activeJob.kind, content: activeJob.text }),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company"
          className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role"
          className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
        />
      </div>
      <textarea
        value={jd}
        onChange={(e) => setJd(e.target.value)}
        placeholder="Job description (optional, improves prep quality)"
        rows={4}
        className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      <input
        type="datetime-local"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      <textarea
        value={contractText}
        onChange={(e) => setContractText(e.target.value)}
        placeholder="Offer/contract text (required only for offer walkthrough)"
        rows={4}
        className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      {hint && <p className="text-xs text-faint">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button
            key={k}
            onClick={() => run(k)}
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {activeJob && (
        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3">
          <p className="text-xs text-faint">{activeJob.status === "running" ? "Running…" : activeJob.status}</p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{activeJob.text}</pre>
          {activeJob.status === "done" && (
            <button
              onClick={save}
              disabled={saveState === "saving" || saveState === "saved"}
              className="mt-2 rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-brand/50 disabled:opacity-60"
            >
              {saveState === "saved" ? "Saved to interview-prep/" : saveState === "saving" ? "Saving…" : "Save to interview-prep/"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

**Step 4: Manual verification**

Run: `cd web && npm run dev`, open `http://localhost:3000/interview`.

- Fill in company + role, click "Generate prep brief" — confirm it streams output and shows a Save button once done.
- Click Save — confirm `interview-prep/{company-slug}-{role-slug}.md` is created with a `## Prep Brief` section.
- Fill in a date, click "Build prep plan" — confirm the plan references the date. Save it — confirm the SAME file now has both `## Prep Brief` and `## Prep Plan` sections (not two files).
- Paste sample offer text, click "Walk through offer" — confirm the output never assigns a severity score to a clause, and its final VERDICT line describes completeness, not the offer's merit.

**Step 5: Commit**

```bash
cd web
git add src/app/interview/page.tsx src/components/interview/interview-form.tsx
git commit -m "feat(web): add /interview page for prep briefs, plans, and offer walkthroughs"
```

---

## Task 8: Full test suite + final manual pass

**Step 1: Run the whole web suite**

Run: `cd web && npm test`
Expected: all suites pass, including every test added in Tasks 1–3.

**Step 2: Full typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean build.

**Step 3: End-to-end manual pass**

With a real career-ops checkout (real `cv.md`, `config/profile.yml`, at least one evaluated report):

1. Run all three kinds against a real company/role from `npm run dev` → `/interview`.
2. Confirm `interview-prep`/`interview-plan` 400 clearly if `cv.md` is temporarily renamed away (Task 4's gate).
3. Confirm the CLI (`/career-ops interview-prep {company} {role}`) still reads the file the web Save button wrote, without complaint — the whole point of the backend-owned write is that CLI and web share one file format.

**Step 4: Final commit (if the manual pass required any fixes)**

```bash
cd web
git add -A
git commit -m "fix(web): address issues found in interview UI manual pass"
```
