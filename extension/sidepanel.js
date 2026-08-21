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
let activeCapture = null;
let busy = false;

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
    args = JSON.parse(env.argsJson.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
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
  if (busy) return;
  busy = true;
  inputEl.disabled = true;
  sendEl.disabled = true;
  try {
    const userDiv = addMessage("user", message);
    void userDiv;
    history.push({ role: "user", content: message });
    const assistantDiv = addMessage("assistant", "…");

    const pageContext = activeCapture
      ? `CAPTURED PAGE (from the browser extension, read while the user was viewing it):\nURL: ${activeCapture.url}\nTitle: ${activeCapture.title}\n\n${activeCapture.text}`
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
    busy = false;
    inputEl.disabled = false;
    sendEl.disabled = false;
  }
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
  await chrome.storage.session.remove("pendingCapture");
  if (pendingCapture) {
    activeCapture = pendingCapture;
    bannerEl.textContent = `Captured: ${pendingCapture.title || pendingCapture.url}`;
    bannerEl.classList.remove("hidden");
    if (cliId) send("Evaluate this job.");
  }
})();
