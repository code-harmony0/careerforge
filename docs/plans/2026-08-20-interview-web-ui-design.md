# Interview prep in the web UI — v1 design

## Problem

career-ops has mature interview-prep capability (`modes/interview-prep.md`,
`modes/interview/plan.md`, `modes/offer-prep.md`, plus `interview/practice.md`
and `interview/debrief.md`), but it's CLI/agent-session only. The web app
(`web/`) has no `/interview` surface at all.

## Scope

**v1 (this design):** the three one-shot capabilities — company/role prep
briefs, time-blocked prep plans, negotiation scripts. These map cleanly onto
the existing one-shot worker pattern (`kind` → prompt → stream → done).

**Explicitly out of scope for v1:** mock interview practice, post-interview
debrief, and story-bank building. These are multi-turn conversations (ask →
answer → follow-up → feedback) and need new chat-session infrastructure the
web app doesn't have yet. Tracked as v2.

## Design

### New worker kinds

Add three kinds to `web/src/lib/run-prompts.mjs`, following the exact shape
already used by `cover`/`training`/`deep`:

- `interview-prep` — runs the real `modes/interview-prep.md`. Reads `cv.md`,
  `config/profile.yml`, `interview-prep/story-bank.md` (if present),
  `reports/{input}-*.md` for company/role/JD context.
- `interview-plan` — runs `modes/interview/plan.md`. Same inputs, plus
  interview date/time.
- `offer-prep` — runs `modes/offer-prep.md`.

Each prompt ends with the standard `VERDICT: {0-5}/5 — {reason, ≤12 words}`
line, same convention as every other kind.

### Tool scope: read-only, agent never writes

These stay in `TOOL_SCOPES.readOnly` in `claude-invocation.mjs` — no Write/Bash
for the agent. This matches the codebase's existing security posture (every
write-capable tool a kind doesn't need is explicitly denied, not just
omitted) and the same reasoning that keeps `cover`/`email`/`training`
read-only: an agent given a real JD as untrusted input should not hold a
write tool.

### Save button — backend-owned write

The UI adds a **Save** action on the finished stream output. It POSTs the
exact rendered markdown to a new small route,
`web/src/app/api/interview/save/route.ts`, which writes it to
`interview-prep/{company-slug}-{role-slug}.md` (creating the file, or
appending a `## Prep Brief` / `## Prep Plan` / `## Negotiation` section if it
already exists — mirroring `modes/interview/plan.md`'s own Step 5 convention).
The backend is the only writer, same pattern as the PDF envelope flow — the
agent's streamed text is data, never a file write instruction.

### UI

- New page `web/src/app/interview/page.tsx`. Form: company (required), role
  (required), optional JD paste/link, optional interview date+time (only
  relevant for `interview-plan`). Three action buttons, one per kind — same
  interaction shape as `TrainingEvaluate`.
- Reuses `useJobs().startJob({ kind, input, title, subtitle, page })` — no new
  streaming/display component needed; results surface in the existing Workers
  tray.
- New nav entry in `web/src/lib/nav-items.ts`: `{ href: "/interview", label:
  "Interview", icon: <TBD>, chip: "New" }`.

### Guards

- Add `interview-prep`, `interview-plan`, `offer-prep` to `KNOWN_KINDS` in
  `claude-invocation.mjs`.
- Add each to the `needsScript` map in `api/run/route.ts` (`modes/interview-prep.md`,
  `modes/interview/plan.md`, `modes/offer-prep.md`) so a route with an
  incomplete checkout fails clearly instead of silently.
- `interview-prep` and `interview-plan` should 400 the same way `evaluate`
  does when `cv.md` is missing — a brief/plan without a CV is a hallucinated
  one.

## Testing

- Unit tests for the three new `buildPrompt` branches in
  `web/tests/lib/run-prompts.test.mjs` (existing suite), asserting the prompt
  text references the right mode file and ends with the VERDICT line —
  matching how existing kinds are asserted on as values, not via source-text
  matching.
- Unit test for the save route: writes a new file when none exists, appends a
  section when one does, rejects an unsafe company/role slug.
- Manual: run all three kinds against a real report in a working checkout,
  confirm output streams, confirm Save writes to the right path.

## v2 (not built now, noted for later)

Mock interview practice, debrief, and story-bank building as a chat-style
session — new persistent-conversation infrastructure, a bigger and separate
piece of work.
