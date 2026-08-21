# Browser extension: career-ops bridge — design

## Problem

Job hunting happens across many platforms (LinkedIn, Indeed, company career pages,
ATS-hosted forms). Today, using career-ops on a posting requires copying its URL
out of the browser and pasting it into the local web app or a CLI. That
context-switch is the actual friction — the user described it as "a huge gap
between the product."

## Goal

A Chrome extension that, from any page, lets the user:
1. Capture the current job posting and get it evaluated (score + report).
2. Jump into applying for it (reusing the existing headed-Playwright apply
   session).
3. Get help drafting a recruiter message, grounded in the same CV/profile.

**Constraint (explicit, from the user):** reuse existing career-ops features —
evaluation, apply, PDF, tracker, memory — as-is. The extension is a capture/
hand-off surface, not a reimplementation of any of them.

## Why an extension adds real value (not just convenience)

career-ops already evaluates from a URL by fetching it server-side (Playwright
or WebFetch, see "Offer Verification" in AGENTS.md). Many job platforms
(LinkedIn especially) gate content behind login or heavy client-side rendering
that a fresh server-side fetch can't see. The browser extension runs inside the
user's already-authenticated tab, so it can capture what a server-side fetch
cannot. That's the extension's actual reason to exist, not just UI convenience.

## Architecture

### 1. Content script (`<all_urls>`)

A small, unobtrusive edge pill (not a full-page floating action button). On
click, it captures:

```
{ url: location.href, title: document.title, text: <visible text, whitespace-collapsed, capped ~15k chars> }
```

No DOM writes, no clicks, no form interaction — capture only, mirroring the
read-only boundary `browser-extract.mjs` already documents for the equivalent
server-side extractor.

### 2. Background service worker

`host_permissions` scoped to `http://localhost/*` and `http://127.0.0.1/*`
only — the extension cannot talk to any other host, so it cannot become a
data-exfiltration path. Receives the capture from the content script, opens
the extension's side panel, and forwards the payload to it.

### 3. Side panel (new, thin UI)

A minimal chat surface — message list + input, nothing else. It talks
directly to the existing `/api/assistant` endpoint
(`web/src/app/api/assistant/route.ts`), passing the captured page as
`pageContext`. On first open after a capture, it auto-sends "Evaluate this
job" so the score appears without the user having to type anything; after
that it's a normal chat, so the user can ask for a recruiter-message draft,
ask to apply, ask about fit, etc. — the assistant already knows how to do all
of this.

This UI is new code, but it contains no career-ops business logic — it is a
narrower window onto the same brain the web app's `assistant-console.tsx`
already drives.

### 4. Shared action-executor module (refactor, not a new feature)

`assistant-console.tsx` currently parses `<<act:ACTION_ID {...}>>` envelopes
and executes them inline, coupled to the web app's own page (React router,
pipeline table state, apply-session state). Extract this into
`web/src/lib/assistant-actions.ts`, used by both the web app and the side
panel:

- **Backend actions** (`evaluate`, `evaluateCompany`, `research`,
  `generatePdf`, `setStatus`, `remember`, `setProfile`, `setPortals`) — pure
  fetches to existing routes (`/api/run`, `/api/status`, etc.). Run
  identically from the side panel.
- **UI-state actions** (`navigate`, `filterPipeline`, `apply`,
  `setApplyField`) — only meaningful inside the full web app (there's no
  pipeline table or apply form rendered in a side panel). From the side
  panel these open/focus a career-ops browser tab at the corresponding URL
  instead of manipulating in-page state. This is exactly how apply-assist
  reuses the existing headed-Playwright session (`web/src/lib/apply/session.ts`)
  with zero new fill logic — the side panel's `apply` handling is just
  `chrome.tabs.create({url: "http://localhost:PORT/apply?url=..."})`.

### 5. One additive change to the web app

`/api/assistant`'s `pageContext` is currently built only from the web app's
own route (`describePage(pathname) + pipelineContext() + applyContext()`,
`assistant-console.tsx:355`). It needs a second source: an externally
captured page. Additive — the existing internal-route behavior is untouched
when there's no external capture.

### 6. Options page

Server URL/port (default `localhost:3000`), CLI id to use (populated from
the existing `/api/clis` route). Stored in `chrome.storage.local`, set once.

## Explicitly out of scope / not rebuilt

- Evaluation logic (`modes/oferta.md`, `/api/run`)
- Apply/fill logic (`web/src/lib/apply/*`)
- PDF generation, tracker writes, memory, follow-ups
- Recruiter-message drafting logic — the assistant already drafts prose from
  CV/profile in plain chat; no new action/envelope needed for v1.

## Error handling

- career-ops web app not running locally → side panel shows "career-ops not
  running — start `npm run dev` in `web/`" instead of failing silently.
- Evaluation/action calls can be long-running (existing `maxDuration` up to
  800s on `/api/run`) — side panel shows progress via the same NDJSON
  streaming the web app already consumes; closing the panel does not cancel
  the server-side run.

## Testing plan (manual)

- Capture + evaluate on: a LinkedIn job posting (authenticated), a Greenhouse
  posting, an Ashby posting, a generic company careers page.
- Apply hand-off: side panel `apply` action opens/focuses the existing
  headed-Playwright apply flow correctly for a captured URL.
- Recruiter-message ask in chat produces a grounded draft (no fabricated
  claims — same Source-of-Truth Boundary as the rest of career-ops).
- Extension with career-ops web app not running: clear error, no silent
  failure.
- `host_permissions` verified to reject any non-localhost target.
