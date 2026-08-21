// extension/sidepanel.js
// The primary flow (capture → evaluate → result) is a deterministic action —
// we already know the user wants an evaluation, so it calls runEvaluate()
// directly against /api/run. It does NOT go through /api/assistant: routing
// a known action through an LLM chat round-trip just to have it decide to
// call the same action back is wasted latency and (this was the actual bug
// a real user hit) produces a raw chat transcript instead of a result. The
// chat composer below is for genuine follow-up questions ("apply to this",
// "draft a message to the recruiter") where the assistant's judgment is
// actually needed — that still goes through /api/assistant with envelope
// handling, unchanged from before.
import { parseEnvelopes, stripEnvelopes, actionToPath } from "./lib/envelopes.js";
import { runEvaluate } from "./lib/run-evaluate.js";
import { scoreTone } from "./lib/verdict.js";

const DEFAULT_SERVER = "http://localhost:3000";

const els = {
  captureCard: document.getElementById("capture-card"),
  captureTitle: document.getElementById("capture-title"),
  captureUrl: document.getElementById("capture-url"),
  captureWarning: document.getElementById("capture-warning"),
  evaluateAnyway: document.getElementById("evaluate-anyway"),
  statusRow: document.getElementById("status-row"),
  statusText: document.getElementById("status-text"),
  resultCard: document.getElementById("result-card"),
  scoreBadge: document.getElementById("score-badge"),
  resultSummary: document.getElementById("result-summary"),
  openReport: document.getElementById("open-report"),
  errorCard: document.getElementById("error-card"),
  errorText: document.getElementById("error-text"),
  retry: document.getElementById("retry"),
  emptyState: document.getElementById("empty-state"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
};

let history = [];
let serverUrl = DEFAULT_SERVER;
let cliId = "";
let activeCapture = null;
let chatBusy = false;

// ── evaluate state machine ──────────────────────────────────────────────
// One of: 'idle' | 'listing-warning' | 'evaluating' | 'result' | 'error'
function setEvalState(state) {
  els.captureCard.classList.toggle("hidden", state === "idle");
  els.captureWarning.classList.toggle("hidden", state !== "listing-warning");
  els.statusRow.classList.toggle("hidden", state !== "evaluating");
  els.resultCard.classList.toggle("hidden", state !== "result");
  els.errorCard.classList.toggle("hidden", state !== "error");
  els.emptyState.classList.toggle("hidden", state !== "idle");
}

function renderCapture(capture) {
  els.captureTitle.textContent = capture.title || "(untitled page)";
  els.captureUrl.textContent = capture.url;
}

function startEvaluate(capture) {
  if (!cliId) {
    els.errorText.textContent = "No CLI configured yet — open the extension's Options page to pick one.";
    setEvalState("error");
    return;
  }
  setEvalState("evaluating");
  els.statusText.textContent = "Starting…";
  runEvaluate({
    serverUrl,
    cliId,
    url: capture.url,
    onStatus: (label) => {
      els.statusText.textContent = label;
    },
    onDone: ({ score, summary, reportUrl }) => {
      const tone = scoreTone(score);
      els.scoreBadge.className = tone;
      els.scoreBadge.textContent = score != null ? `${score}/5` : "No score";
      els.resultSummary.textContent = summary || (score == null ? "The report didn't contain a recognizable VERDICT line." : "");
      if (reportUrl) {
        els.openReport.href = reportUrl;
        els.openReport.classList.remove("hidden");
      } else {
        els.openReport.classList.add("hidden");
      }
      setEvalState("result");
    },
    onError: (msg) => {
      els.errorText.textContent = msg;
      setEvalState("error");
    },
  });
}

els.evaluateAnyway.addEventListener("click", () => startEvaluate(activeCapture));
els.retry.addEventListener("click", () => activeCapture && startEvaluate(activeCapture));

// ── chat (follow-up questions, unchanged behavior) ──────────────────────
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function addActionLink(label, onClick) {
  const a = document.createElement("div");
  a.className = "action-link";
  a.textContent = label;
  a.addEventListener("click", onClick);
  els.messages.appendChild(a);
  els.messages.scrollTop = els.messages.scrollHeight;
  return a;
}

async function openCareerOpsTab(path) {
  try {
    await chrome.tabs.create({ url: `${serverUrl}${path}` });
  } catch {
    /* extension context gone / invalid URL — nothing more we can do here */
  }
}

async function executeEnvelope(env) {
  let args = {};
  try {
    args = JSON.parse(env.argsJson.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  } catch {
    /* malformed args — fall through with {} */
  }
  if (env.id === "evaluate" && args.url) {
    const link = addActionLink(`Evaluating ${args.url}…`, () => {});
    runEvaluate({
      serverUrl,
      cliId,
      url: args.url,
      onStatus: (label) => {
        link.textContent = label;
      },
      onDone: ({ score, summary, reportUrl }) => {
        link.textContent = score != null ? `Score: ${score}/5${summary ? ` — ${summary}` : ""}` : "Done — no score line found.";
        if (reportUrl) addActionLink(`Open report → ${reportUrl}`, () => chrome.tabs.create({ url: reportUrl }));
      },
      onError: (msg) => {
        link.textContent = `Error: ${msg}`;
      },
    });
    return;
  }
  const path = actionToPath(env.id, args);
  addActionLink(`Open in career-ops → ${path}`, () => openCareerOpsTab(path));
}

async function sendChat(message) {
  if (chatBusy) return;
  chatBusy = true;
  els.input.disabled = true;
  els.send.disabled = true;
  try {
    addMessage("user", message);
    history.push({ role: "user", content: message });
    const assistantDiv = addMessage("assistant", "…");

    const pageContext = activeCapture
      ? `CAPTURED PAGE (from the browser extension, read while the user was viewing it):\nURL: ${activeCapture.url}\nTitle: ${activeCapture.title}\n\n${activeCapture.text}`
      : undefined;

    let res;
    try {
      res = await fetch(`${serverUrl}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, cliId, history: history.slice(-8), pageContext }),
      });
    } catch {
      assistantDiv.textContent = "career-ops isn't reachable — is `npm run dev` running in web/?";
      return;
    }
    if (!res.ok || !res.body) {
      assistantDiv.textContent = "career-ops isn't reachable — is `npm run dev` running in web/?";
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let executedUpTo = 0;
    try {
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
    } catch {
      assistantDiv.textContent = `${assistantDiv.textContent}\n\n[connection lost while streaming]`;
    }
    history.push({ role: "assistant", content: assistantDiv.textContent });
  } finally {
    chatBusy = false;
    els.input.disabled = false;
    els.send.disabled = false;
  }
}

els.send.addEventListener("click", () => {
  const v = els.input.value.trim();
  if (!v) return;
  els.input.value = "";
  sendChat(v);
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.send.click();
});

// ── capture handling ────────────────────────────────────────────────────
// A side panel, once opened, normally stays open while the user keeps
// browsing (that's the whole point of a side panel) — it is NOT reloaded
// each time the pill is clicked on a new tab. So a new capture has to be
// handled two ways: the one that was already pending when this panel
// document loaded (handled once, in init(), below), and any capture that
// arrives WHILE this panel is already open, which only chrome.storage's
// change event can tell us about.
function handleCapture(capture) {
  activeCapture = capture;
  renderCapture(capture);
  if (capture.isListingUrl) {
    setEvalState("listing-warning");
  } else {
    startEvaluate(capture);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.pendingCapture?.newValue) return;
  const capture = changes.pendingCapture.newValue;
  chrome.storage.session.remove("pendingCapture");
  handleCapture(capture);
});

// ── init ─────────────────────────────────────────────────────────────────
(async function init() {
  const cfg = await chrome.storage.local.get(["serverUrl", "cliId"]);
  serverUrl = (cfg.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
  cliId = cfg.cliId || "";

  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  await chrome.storage.session.remove("pendingCapture");

  if (!pendingCapture) {
    setEvalState("idle");
    if (!cliId) addMessage("assistant", "No CLI configured yet — open the extension's Options page to pick one.");
    return;
  }

  handleCapture(pendingCapture);
})();
