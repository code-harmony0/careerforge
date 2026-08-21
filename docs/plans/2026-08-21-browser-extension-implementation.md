# career-ops Browser Bridge Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A Chrome (MV3) extension that captures the page you're viewing (job posting or application form) and hands it to the local career-ops web app's existing `/api/assistant`, so evaluation, apply, PDF, status, and research all run through code that already exists — the extension adds zero new business logic.

**Architecture:** Content script captures `{url, title, text}` on click of an in-page pill → background service worker (host-permission-locked to `localhost`/`127.0.0.1`) relays it and opens the Chrome side panel → side panel is a small vanilla-JS chat UI that POSTs to `/api/assistant` with the capture as `pageContext`, streams the reply, and natively re-runs the `evaluate` action (replicating the ~60-line fetch/stream loop `web/src/components/jobs/job-store.tsx` already uses against `/api/run` — same route, same contract, no new server logic). Every other `<<act:ID {...}>>` the assistant emits (apply, generatePdf, setStatus, research, setProfile, setPortals, evaluateCompany, navigate, filterPipeline) opens/focuses a career-ops browser tab at the matching route, so the *real* web app UI (with its full `useJobs`/`useApply`/`usePipeline` state) finishes the job exactly as it does today. Nothing about evaluation, apply-fill, PDF rendering, or the tracker is reimplemented.

**Tech Stack:** Plain JS (no bundler — MV3 supports ES modules natively in service workers and pages), Chrome extension APIs (`sidePanel`, `storage`, `tabs`, `scripting`), `node --test` for the pure-logic unit tests (matches the repo's existing test convention).

**Deviation from the design doc:** the design doc proposed extracting a shared `assistant-actions.ts` module used by both the web app and the extension. Investigation during planning found action execution in `assistant-console.tsx` is coupled to React hooks (`useJobs`, `useApply`, `usePipeline`) that track running-job UI state — not a simple fetch dispatch table. Reusing it directly would require bundling web-app TypeScript into an MV3 extension (real build-pipeline cost for a personal tool). Instead: the extension replicates only the one action worth running natively (`evaluate`, using the same plain fetch/stream pattern `job-store.tsx` already uses against the same `/api/run` route — not new logic, just not shared via import) and routes every other action to the real web app tab. This is a smaller, safer change; revisit sharing code if/when more actions need native handling.

---

### Task 0: Directory scaffold

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/README.md`

**Step 1: Create the directory and manifest**

```json
{
  "manifest_version": 3,
  "name": "career-ops bridge",
  "version": "0.1.0",
  "description": "Capture the job posting you're viewing and send it to your local career-ops assistant.",
  "permissions": ["storage", "tabs", "sidePanel", "activeTab"],
  "host_permissions": ["http://localhost/*", "http://127.0.0.1/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["lib/extract.js", "content-script.js"],
      "css": ["content-script.css"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_title": "career-ops: capture this page" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_page": "options.html"
}
```

**Step 2: Write the README**

```markdown
# career-ops bridge extension

Unpublished, load-unpacked personal extension. Talks ONLY to `localhost`/`127.0.0.1`
(see `host_permissions` in manifest.json) — it cannot reach any other host.

## Install (dev)

1. Start the career-ops web app: `cd ../web && npm run dev`
2. Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select this `extension/` directory.
3. Click the extension icon once → Options → confirm the server URL (default `http://localhost:3000`) and pick a CLI id.
4. On any page, click the small "co" pill at the bottom-right edge to capture + evaluate.

## What it does and doesn't do

- Captures page URL/title/visible text on click. Read-only — never clicks, types, or submits anything on the page you're browsing.
- Sends the capture to your own local career-ops web app's `/api/assistant` — the exact same assistant the web app's chat uses.
- "Evaluate this job" runs natively in the side panel (same `/api/run` call the web app makes). Every other action (apply, generate PDF, change status, research, etc.) opens/focuses a career-ops browser tab so the real web app finishes it — nothing is reimplemented.
```

**Step 3: Commit**

```bash
mkdir -p extension
git add extension/manifest.json extension/README.md
git commit -m "feat(extension): scaffold MV3 extension manifest"
```

---

### Task 1: Pure capture-extraction logic (unit tested)

**Files:**
- Create: `extension/lib/extract.js`
- Test: `extension/tests/extract.test.mjs`

**Step 1: Write the failing test**

```javascript
// extension/tests/extract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseWhitespace, capText } from "../lib/extract.js";

test("collapseWhitespace squashes runs of whitespace to single spaces", () => {
  assert.equal(collapseWhitespace("a\n\n  b\t\tc"), "a b c");
});

test("collapseWhitespace trims leading/trailing whitespace", () => {
  assert.equal(collapseWhitespace("  hello world  "), "hello world");
});

test("capText leaves short text untouched", () => {
  assert.equal(capText("short", 100), "short");
});

test("capText truncates long text to the exact cap length", () => {
  const long = "x".repeat(200);
  const capped = capText(long, 100);
  assert.equal(capped.length, 100);
});
```

**Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/extract.test.mjs`
Expected: FAIL — `../lib/extract.js` does not exist yet.

**Step 3: Write minimal implementation**

```javascript
// extension/lib/extract.js
// Pure, DOM-free helpers so they're unit-testable with node --test.
// Loaded as a plain <script>/content-script (not a module) so it also works
// unbundled inside content-script.js — exported via `export` for the test
// runner AND attached to `self` for the content-script's non-module context.

export function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

export function capText(s, maxChars) {
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

const JD_TEXT_CAP = 15000;

// DOM-dependent — not unit tested here, exercised manually in the browser.
export function capturePage(doc = document) {
  const text = capText(collapseWhitespace(doc.body?.innerText || ""), JD_TEXT_CAP);
  return { url: location.href, title: doc.title || "", text };
}

if (typeof self !== "undefined") {
  self.careerOpsExtract = { collapseWhitespace, capText, capturePage };
}
```

**Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/extract.test.mjs`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add extension/lib/extract.js extension/tests/extract.test.mjs
git commit -m "feat(extension): add pure page-capture text helpers with tests"
```

---

### Task 2: Content script — capture pill

**Files:**
- Create: `extension/content-script.js`
- Create: `extension/content-script.css`

**Step 1: Write the pill styles**

```css
/* extension/content-script.css */
#career-ops-pill {
  position: fixed;
  right: 0;
  bottom: 24px;
  z-index: 2147483647;
  background: #1f2937;
  color: #fff;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 8px 12px 8px 14px;
  border-radius: 8px 0 0 8px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  opacity: 0.75;
  transition: opacity 0.15s ease;
  user-select: none;
}
#career-ops-pill:hover {
  opacity: 1;
}
#career-ops-pill.co-busy {
  opacity: 1;
  background: #374151;
}
```

**Step 2: Write the content script**

```javascript
// extension/content-script.js
// Relies on lib/extract.js having run first (declared before this file in
// manifest.json's content_scripts.js array) and set self.careerOpsExtract.
(function () {
  if (document.getElementById("career-ops-pill")) return; // frames / re-injection guard

  const pill = document.createElement("div");
  pill.id = "career-ops-pill";
  pill.textContent = "career-ops";
  document.documentElement.appendChild(pill);

  pill.addEventListener("click", () => {
    if (pill.classList.contains("co-busy")) return;
    pill.classList.add("co-busy");
    pill.textContent = "capturing…";
    const capture = self.careerOpsExtract.capturePage(document);
    chrome.runtime.sendMessage({ type: "career-ops:capture", capture }, (resp) => {
      pill.classList.remove("co-busy");
      pill.textContent = chrome.runtime.lastError || !resp?.ok ? "capture failed" : "career-ops";
      if (!chrome.runtime.lastError && resp?.ok) {
        setTimeout(() => {
          pill.textContent = "career-ops";
        }, 1500);
      }
    });
  });
})();
```

**Step 3: Manual verification**

Load the unpacked extension (Task 0's README steps), open any web page, confirm a
small dark "career-ops" pill appears bottom-right, and clicking it briefly shows
"capturing…" then reverts (background/side panel wiring comes next, so at this
point `chrome.runtime.sendMessage` will fail with "Receiving end does not
exist" — expected until Task 3).

**Step 4: Commit**

```bash
git add extension/content-script.js extension/content-script.css
git commit -m "feat(extension): add in-page capture pill"
```

---

### Task 3: Background service worker — relay + open side panel

**Files:**
- Create: `extension/background.js`

**Step 1: Write the service worker**

```javascript
// extension/background.js
// host_permissions in manifest.json restricts this worker to localhost/127.0.0.1
// — it is structurally unable to fetch or relay data to any other host.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "career-ops:capture") return false;
  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: "no source tab" });
    return false;
  }

  // Must be called synchronously in the gesture-triggered listener, before any
  // await, or Chrome refuses it as "not a user gesture" (side panel API quirk).
  chrome.sidePanel.open({ tabId }).catch(() => {
    /* already open, or user gesture window closed — non-fatal */
  });

  chrome.storage.session
    .set({ pendingCapture: { ...msg.capture, capturedAt: Date.now() } })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true; // keep the message channel open for the async sendResponse above
});

// Toolbar-icon click also opens the panel (without a capture) for ad-hoc chat.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
```

**Step 2: Manual verification**

Reload the extension in `chrome://extensions`, click the capture pill on any
page — the Chrome side panel should now open (it will be blank/error until
Task 4 adds `sidepanel.html`). Check `chrome://extensions` → the extension's
"service worker" inspector for console errors.

**Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat(extension): relay captures to storage and open the side panel"
```

---

### Task 4: Options page — server URL + CLI id

**Files:**
- Create: `extension/options.html`
- Create: `extension/options.js`

**Step 1: Write the options page**

```html
<!-- extension/options.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>career-ops bridge — options</title>
    <style>
      body { font: 14px/1.5 -apple-system, sans-serif; padding: 16px; max-width: 420px; }
      label { display: block; margin-top: 12px; font-weight: 600; }
      input, select { width: 100%; padding: 6px 8px; margin-top: 4px; box-sizing: border-box; }
      #status { margin-top: 12px; color: #16a34a; }
    </style>
  </head>
  <body>
    <h2>career-ops bridge</h2>
    <label>Server URL
      <input id="serverUrl" placeholder="http://localhost:3000" />
    </label>
    <label>CLI
      <select id="cliId"></select>
    </label>
    <button id="save">Save</button>
    <div id="status"></div>
    <script src="options.js"></script>
  </body>
</html>
```

**Step 2: Write the options script**

```javascript
// extension/options.js
const DEFAULT_SERVER = "http://localhost:3000";

async function load() {
  const { serverUrl = DEFAULT_SERVER, cliId = "" } = await chrome.storage.local.get(["serverUrl", "cliId"]);
  document.getElementById("serverUrl").value = serverUrl;

  const select = document.getElementById("cliId");
  try {
    const res = await fetch(`${serverUrl}/api/clis`);
    const clis = await res.json();
    select.innerHTML = (Array.isArray(clis) ? clis : clis.clis || [])
      .map((c) => `<option value="${c.id}">${c.name || c.id}</option>`)
      .join("");
    if (cliId) select.value = cliId;
  } catch {
    select.innerHTML = `<option value="">could not reach ${serverUrl} — is career-ops running?</option>`;
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const serverUrl = document.getElementById("serverUrl").value.trim().replace(/\/+$/, "") || DEFAULT_SERVER;
  const cliId = document.getElementById("cliId").value;
  await chrome.storage.local.set({ serverUrl, cliId });
  document.getElementById("status").textContent = "Saved.";
  setTimeout(() => (document.getElementById("status").textContent = ""), 1500);
});

load();
```

**Step 3: Manual verification**

Reload the extension, open its Options page (right-click icon → Options, or
`chrome://extensions` → Details → Extension options). With `web/` running,
confirm the CLI dropdown populates from `/api/clis`; with it stopped, confirm
the fallback error option appears instead of a blank/broken page.

**Step 4: Commit**

```bash
git add extension/options.html extension/options.js
git commit -m "feat(extension): add options page for server URL and CLI id"
```

---

### Task 5: Pure envelope-parsing + action-routing logic (unit tested)

This ports the *complete-envelope* half of `assistant-console.tsx`'s
`parseEnvelopes` (streaming-partial hiding is a rendering nicety the side
panel's simpler chunk-by-chunk redraw doesn't need) plus a new action→route
map for the "open the real app tab" actions.

**Files:**
- Create: `extension/lib/envelopes.js`
- Test: `extension/tests/envelopes.test.mjs`

**Step 1: Write the failing test**

```javascript
// extension/tests/envelopes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelopes, actionToPath } from "../lib/envelopes.js";

test("parseEnvelopes finds a single complete envelope", () => {
  const text = 'Sure, scoring it now.\n<<act:evaluate {"url":"https://x.com/job"}>>\nDone.';
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 1);
  assert.equal(complete[0].id, "evaluate");
  assert.deepEqual(JSON.parse(complete[0].argsJson), { url: "https://x.com/job" });
});

test("parseEnvelopes ignores envelopes inside code fences", () => {
  const text = "```\n<<act:evaluate {\"url\":\"x\"}>>\n```";
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 0);
});

test("parseEnvelopes returns no complete envelopes for an unterminated one", () => {
  const text = '<<act:evaluate {"url":"https://x.com/job"';
  const { complete } = parseEnvelopes(text);
  assert.equal(complete.length, 0);
});

test("actionToPath maps setStatus to the report page", () => {
  assert.equal(actionToPath("setStatus", { n: "42" }), "/pipeline/42");
});

test("actionToPath maps navigate to its own path arg", () => {
  assert.equal(actionToPath("navigate", { path: "/analytics" }), "/analytics");
});

test("actionToPath falls back to home for an unknown action id", () => {
  assert.equal(actionToPath("somethingNew", {}), "/");
});
```

**Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/envelopes.test.mjs`
Expected: FAIL — `../lib/envelopes.js` does not exist yet.

**Step 3: Write minimal implementation**

```javascript
// extension/lib/envelopes.js

function codeRanges(s) {
  const ranges = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(s))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
function inRanges(i, ranges) {
  return ranges.some(([a, b]) => i >= a && i < b);
}

// Mirrors web/src/components/assistant-console.tsx's parseEnvelopes for the
// COMPLETE-envelope case (the side panel redraws the whole message on every
// chunk, so it doesn't need that file's partial-hiding bookkeeping).
export function parseEnvelopes(acc) {
  const ranges = codeRanges(acc);
  const complete = [];
  const open = /<<act:([a-zA-Z]+)[ \t]+/g;
  let m;
  while ((m = open.exec(acc))) {
    const start = m.index;
    if (inRanges(start, ranges)) continue;
    const argsStart = m.index + m[0].length;
    const close = acc.indexOf(">>", argsStart);
    if (close === -1) continue;
    complete.push({ start, end: close + 2, id: m[1], argsJson: acc.slice(argsStart, close).trim() });
  }
  return { complete };
}

export function stripEnvelopes(text, envelopes) {
  if (!envelopes.length) return text;
  let out = "";
  let pos = 0;
  for (const { start, end } of [...envelopes].sort((a, b) => a.start - b.start)) {
    if (start > pos) out += text.slice(pos, start);
    pos = Math.max(pos, end);
  }
  return out + text.slice(pos);
}

// "evaluate" is handled NATIVELY in sidepanel.js (same /api/run call the web
// app makes). Every other action opens/focuses a real career-ops tab so the
// existing web app UI finishes the job — see the implementation plan's
// "Deviation from the design doc" note for why.
const ROUTES = {
  navigate: (a) => a.path || "/",
  filterPipeline: (a) => `/pipeline?tab=${a.tab || "ALL"}&min=${a.min ?? 0}${a.q ? `&q=${encodeURIComponent(a.q)}` : ""}`,
  evaluateCompany: (a) => `/pipeline?tab=INBOX${a.company ? `&q=${encodeURIComponent(a.company)}` : ""}`,
  research: () => "/",
  generatePdf: (a) => (a.n ? `/pipeline/${a.n}` : "/pipeline"),
  setStatus: (a) => (a.n ? `/pipeline/${a.n}` : "/pipeline"),
  apply: (a) => `/apply${a.url ? `?url=${encodeURIComponent(a.url)}` : ""}`,
  setApplyField: () => "/apply",
  remember: () => "/",
  setProfile: () => "/config",
  setPortals: () => "/portals",
};

export function actionToPath(id, args) {
  const fn = ROUTES[id];
  return fn ? fn(args || {}) : "/";
}
```

**Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/envelopes.test.mjs`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add extension/lib/envelopes.js extension/tests/envelopes.test.mjs
git commit -m "feat(extension): add envelope parsing and action-to-route mapping with tests"
```

---

### Task 6: Pure VERDICT parsing (unit tested)

Ports `parseVerdict` from `web/src/components/jobs/job-store.tsx:49-61` verbatim
(same regexes) so the side panel's native `evaluate` handling shows the same
score/summary the web app would.

**Files:**
- Create: `extension/lib/verdict.js`
- Test: `extension/tests/verdict.test.mjs`

**Step 1: Write the failing test**

```javascript
// extension/tests/verdict.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../lib/verdict.js";

test("parses a full VERDICT line with summary", () => {
  const r = parseVerdict("blah\nVERDICT: 4.5/5 — Strong match, apply soon\nblah");
  assert.equal(r.score, 4.5);
  assert.equal(r.summary, "Strong match, apply soon");
});

test("falls back to a bare X/5 pattern with no summary", () => {
  const r = parseVerdict("Overall this scores 3.5/5 based on the criteria.");
  assert.equal(r.score, 3.5);
  assert.equal(r.summary, "");
});

test("returns null score when nothing matches", () => {
  const r = parseVerdict("no score here");
  assert.equal(r.score, null);
});
```

**Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/verdict.test.mjs`
Expected: FAIL — `../lib/verdict.js` does not exist yet.

**Step 3: Write minimal implementation**

```javascript
// extension/lib/verdict.js
export function parseVerdict(text) {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    return { score: parseFloat(m[1]), summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) return { score: parseFloat(s[1]), summary: "" };
  return { score: null, summary: "" };
}
```

**Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/verdict.test.mjs`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add extension/lib/verdict.js extension/tests/verdict.test.mjs
git commit -m "feat(extension): add VERDICT parsing ported from job-store.tsx, with tests"
```

---

### Task 7: Side panel — chat shell + capture banner

**Files:**
- Create: `extension/sidepanel.html`
- Create: `extension/sidepanel.css`

**Step 1: Write the HTML shell**

```html
<!-- extension/sidepanel.html -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>career-ops</title>
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <div id="capture-banner" class="hidden"></div>
    <div id="messages"></div>
    <div id="composer">
      <input id="input" placeholder="Ask career-ops…" />
      <button id="send">Send</button>
    </div>
    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
```

**Step 2: Write the styles**

```css
/* extension/sidepanel.css */
body { margin: 0; font: 13px/1.4 -apple-system, sans-serif; display: flex; flex-direction: column; height: 100vh; }
#capture-banner { background: #eff6ff; color: #1e3a8a; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid #dbeafe; }
#capture-banner.hidden { display: none; }
#messages { flex: 1; overflow-y: auto; padding: 10px; }
.msg { margin-bottom: 10px; white-space: pre-wrap; }
.msg.user { text-align: right; color: #111827; }
.msg.assistant { color: #1f2937; }
.action-link { display: inline-block; margin-top: 4px; font-size: 12px; color: #2563eb; cursor: pointer; text-decoration: underline; }
#composer { display: flex; border-top: 1px solid #e5e7eb; padding: 8px; gap: 6px; }
#input { flex: 1; padding: 6px 8px; }
```

**Step 3: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.css
git commit -m "feat(extension): add side panel chat shell"
```

---

### Task 8: Side panel — assistant chat wired to `/api/assistant`

**Files:**
- Create: `extension/sidepanel.js`

**Step 1: Write the side panel script**

```javascript
// extension/sidepanel.js
import { parseEnvelopes, stripEnvelopes, actionToPath } from "./lib/envelopes.js";
import { runEvaluate } from "./lib/run-evaluate.js";

const DEFAULT_SERVER = "http://localhost:3000";
const messagesEl = document.getElementById("messages");
const bannerEl = document.getElementById("capture-banner");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");

let history = [];
let serverUrl = DEFAULT_SERVER;
let cliId = "";

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addActionLink(label, onClick) {
  const a = document.createElement("div");
  a.className = "action-link";
  a.textContent = label;
  a.addEventListener("click", onClick);
  messagesEl.appendChild(a);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function openCareerOpsTab(path) {
  await chrome.tabs.create({ url: `${serverUrl}${path}` });
}

async function executeEnvelope(env) {
  let args = {};
  try {
    args = JSON.parse(env.argsJson.replace(/[""]/g, '"').replace(/['']/g, "'"));
  } catch {
    /* malformed args — fall through with {} */
  }
  if (env.id === "evaluate" && args.url) {
    addActionLink(`Evaluating ${args.url}…`, () => {});
    const div = addMessage("assistant", "");
    await runEvaluate({ serverUrl, cliId, url: args.url, onText: (t) => (div.textContent = t) });
    return;
  }
  const path = actionToPath(env.id, args);
  addActionLink(`Open in career-ops → ${path}`, () => openCareerOpsTab(path));
}

async function send(message) {
  const userDiv = addMessage("user", message);
  void userDiv;
  history.push({ role: "user", content: message });
  const assistantDiv = addMessage("assistant", "…");

  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  const pageContext = pendingCapture
    ? `CAPTURED PAGE (from the browser extension, read while the user was viewing it):\nURL: ${pendingCapture.url}\nTitle: ${pendingCapture.title}\n\n${pendingCapture.text}`
    : undefined;

  const res = await fetch(`${serverUrl}/api/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, cliId, history: history.slice(-8), pageContext }),
  });
  if (!res.ok || !res.body) {
    assistantDiv.textContent = "career-ops isn't reachable — is `npm run dev` running in web/?";
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let executedUpTo = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += decoder.decode(value, { stream: true });
    const { complete } = parseEnvelopes(full);
    assistantDiv.textContent = stripEnvelopes(full, complete);
    for (const env of complete) {
      if (env.start < executedUpTo) continue;
      executedUpTo = env.end;
      await executeEnvelope(env);
    }
  }
  history.push({ role: "assistant", content: assistantDiv.textContent });
}

sendEl.addEventListener("click", () => {
  const v = inputEl.value.trim();
  if (!v) return;
  inputEl.value = "";
  send(v);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendEl.click();
});

(async function init() {
  const cfg = await chrome.storage.local.get(["serverUrl", "cliId"]);
  serverUrl = (cfg.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
  cliId = cfg.cliId || "";
  if (!cliId) {
    addMessage("assistant", "No CLI configured yet — open the extension's Options page to pick one.");
  }

  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  if (pendingCapture) {
    bannerEl.textContent = `Captured: ${pendingCapture.title || pendingCapture.url}`;
    bannerEl.classList.remove("hidden");
    if (cliId) send("Evaluate this job.");
  }
})();
```

**Step 2: Manual verification**

With `web/` running and Options configured: click the pill on a real job
posting page. The side panel should open, show the capture banner, auto-send
"Evaluate this job.", stream the assistant's reply, and once it emits
`<<act:evaluate {"url":...}>>`, show a live-updating evaluation message. This
step depends on Task 9 (`run-evaluate.js`) existing — write that first if
testing this task in isolation.

**Step 3: Commit**

```bash
git add extension/sidepanel.js
git commit -m "feat(extension): wire side panel chat to /api/assistant with envelope handling"
```

---

### Task 9: Native `evaluate` execution (replicates `job-store.tsx`'s `/api/run` loop)

**Files:**
- Create: `extension/lib/run-evaluate.js`

**Step 1: Write the module**

```javascript
// extension/lib/run-evaluate.js
// Same contract as web/src/components/jobs/job-store.tsx's startJob(): POST
// /api/run, read the NDJSON stream, surface text + VERDICT. Kept separate
// from sidepanel.js so it stays a plain, unit-testable-shaped function (the
// fetch/stream parts aren't unit tested here — no network in node --test —
// but parseVerdict, which it calls, is covered in Task 6).
import { parseVerdict } from "./verdict.js";

export async function runEvaluate({ serverUrl, cliId, url, onText }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", input: url, cliId }),
    });
  } catch {
    onText("Could not reach career-ops to start the evaluation.");
    return;
  }
  if (!res.ok || !res.body) {
    onText("Evaluation failed to start.");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let verdictLine = "";
  let reportNum;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "text") {
        const full = text + ev.text;
        const vm = full.match(/VERDICT:[^\n]*/i);
        if (vm) verdictLine = vm[0];
        text = full.slice(-4000);
        onText(text);
      } else if (ev.type === "done" && typeof ev.reportNum === "string") {
        reportNum = ev.reportNum;
      } else if (ev.type === "error") {
        onText(`Error: ${ev.msg || "unknown"}`);
        return;
      }
    }
  }

  const { score, summary } = parseVerdict(verdictLine || text);
  const scoreLine = score != null ? `Score: ${score}/5${summary ? ` — ${summary}` : ""}` : "Done (no score line found).";
  const linkLine = reportNum ? `\n${serverUrl}/pipeline/${reportNum}` : "";
  onText(`${scoreLine}${linkLine}`);
}
```

**Step 2: Manual verification**

Covered by Task 8's manual verification (this module is exercised from the
side panel, not directly).

**Step 3: Commit**

```bash
git add extension/lib/run-evaluate.js
git commit -m "feat(extension): natively run the evaluate action against /api/run"
```

---

### Task 10: End-to-end manual verification pass

No new files — this task is a checklist, run after Tasks 0–9 are all
committed and the extension is loaded unpacked with `web/` running.

**Step 1: Run the unit test suite**

Run: `cd extension && node --test tests/`
Expected: All tests from Tasks 1, 5, 6 pass (13 tests total).

**Step 2: Manual scenarios**

- [ ] LinkedIn job posting (logged in): click pill → side panel opens →
      capture banner shows the job title → auto-evaluates → score line
      appears with a working `/pipeline/{n}` link.
- [ ] A Greenhouse-hosted posting (e.g. from `data/pipeline.md`): same flow.
- [ ] A generic company careers page that is NOT a single posting: click
      pill anyway — evaluation should complete (likely a low/skip verdict,
      not a crash) — confirms no JD-detection heuristic is required.
- [ ] Ask the side panel chat "apply to this" after a capture: assistant
      emits an `apply` envelope → side panel shows "Open in career-ops →
      /apply?url=..." link → clicking it opens/focuses a tab that lands in
      the existing apply flow.
- [ ] Ask "draft a short message to the recruiter for this role": assistant
      replies with plain prose (no envelope needed) grounded in cv.md/profile
      — confirm no fabricated claims per the Source-of-Truth Boundary.
- [ ] Stop `web/`'s dev server, click the pill: side panel shows the
      "isn't reachable" message instead of hanging or throwing.
- [ ] In `chrome://extensions`, confirm the extension's permissions listing
      shows only `storage`, `tabs`, `sidePanel`, `activeTab` and host access
      restricted to `localhost`/`127.0.0.1`.

**Step 3: Fix anything found, then commit**

```bash
git add -A
git commit -m "test(extension): manual verification pass notes / fixes"
```
