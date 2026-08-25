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
import { runJob } from "./lib/run-job.js";
import { draftApplication } from "./lib/apply-draft.js";
import { scoreTone } from "./lib/verdict.js";

// Source of truth: web/src/lib/format.ts's CANONICAL_STATES / templates/states.yml.
const CANONICAL_STATES = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"];

const DEFAULT_SERVER = "http://localhost:3000";

const els = {
  captureCard: document.getElementById("capture-card"),
  captureTitle: document.getElementById("capture-title"),
  captureUrl: document.getElementById("capture-url"),
  captureWarning: document.getElementById("capture-warning"),
  captureActions: document.getElementById("capture-actions"),
  captureEvaluate: document.getElementById("capture-evaluate"),
  captureFill: document.getElementById("capture-fill"),
  evaluateAnyway: document.getElementById("evaluate-anyway"),
  statusRow: document.getElementById("status-row"),
  statusText: document.getElementById("status-text"),
  stopEval: document.getElementById("stop-eval"),
  resultCard: document.getElementById("result-card"),
  scoreBadge: document.getElementById("score-badge"),
  resultSummary: document.getElementById("result-summary"),
  openReport: document.getElementById("open-report"),
  resultActions: document.getElementById("result-actions"),
  actionPdf: document.getElementById("action-pdf"),
  actionApply: document.getElementById("action-apply"),
  actionCover: document.getElementById("action-cover"),
  actionStatus: document.getElementById("action-status"),
  actionPanel: document.getElementById("action-panel"),
  actionPanelStatus: document.getElementById("action-panel-status"),
  actionPanelStatusText: document.getElementById("action-panel-status-text"),
  actionPanelStop: document.getElementById("action-panel-stop"),
  actionPanelError: document.getElementById("action-panel-error"),
  actionPanelBody: document.getElementById("action-panel-body"),
  errorCard: document.getElementById("error-card"),
  errorText: document.getElementById("error-text"),
  retry: document.getElementById("retry"),
  emptyState: document.getElementById("empty-state"),
  landingEvaluate: document.getElementById("landing-evaluate"),
  landingApply: document.getElementById("landing-apply"),
  landingUrlInput: document.getElementById("landing-url-input"),
  landingUrlFill: document.getElementById("landing-url-fill"),
  messages: document.getElementById("messages"),
  scrollArea: document.getElementById("scroll-area"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  fileInput: document.getElementById("file-input"),
  attachBtn: document.getElementById("attach-btn"),
  screenshotBtn: document.getElementById("screenshot-btn"),
  attachmentPreview: document.getElementById("attachment-preview"),
  attachmentThumb: document.getElementById("attachment-thumb"),
  attachmentDraftForm: document.getElementById("attachment-draft-form"),
  attachmentRemove: document.getElementById("attachment-remove"),
};

let history = [];
let serverUrl = DEFAULT_SERVER;
let cliId = "";
let activeCapture = null;
let pendingAttachment = null; // { dataUrl } — one image queued for the next chat message
let chatBusy = false;
let evalController = null;
let actionController = null;

// ── evaluate state machine ──────────────────────────────────────────────
// One of: 'idle' | 'captured' | 'listing-warning' | 'evaluating' | 'result' | 'error'
function setEvalState(state) {
  els.captureCard.classList.toggle("hidden", state === "idle");
  els.captureWarning.classList.toggle("hidden", state !== "listing-warning");
  els.captureActions.classList.toggle("hidden", state !== "captured");
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
  els.resultActions.classList.add("hidden");
  setEvalState("evaluating");
  els.statusText.textContent = "Starting…";
  evalController = new AbortController();
  runEvaluate({
    serverUrl,
    cliId,
    url: capture.url,
    signal: evalController.signal,
    onStatus: (label) => {
      els.statusText.textContent = label;
    },
    onDone: ({ score, summary, reportNum, appN, reportUrl }) => {
      evalController = null;
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
      wireResultActions({ reportNum, appN, url: capture.url, tabId: capture.tabId });
      setEvalState("result");
    },
    onError: (msg) => {
      evalController = null;
      els.errorText.textContent = msg;
      setEvalState("error");
    },
    onAborted: () => {
      evalController = null;
      els.errorText.textContent = "Evaluation stopped.";
      setEvalState("error");
    },
  });
}

// Each action runs natively in the panel rather than opening a career-ops
// tab: pdf/cover reuse the same /api/run stream evaluate does (runJob),
// status is a single direct write (no LLM involved, same as StatusSelect),
// and apply is a scoped-down READ-ONLY version of the web app's full
// session-driven fill flow (see lib/apply-draft.js's header for why it stops
// short of actually filling the real form). No reportNum yet (report failed
// to parse) means pdf/cover/status have nothing to act on, so they stay
// hidden and only the apply button (which only needs the URL) shows.
//
// reportNum vs appN: pdf/cover glob `reports/{n}-*.md`, so they need the
// REPORT FILE number. Status writes via --row (set-status.mjs), so it needs
// the tracker ROW number instead — a separate, diverging counter (see
// career-ops.ts's findApplicationByReportNum). Mixing these up is exactly
// what made status updates fail with "No tracker row with #N" once a
// report's number and its row's number stopped matching.
function wireResultActions({ reportNum, appN, url, tabId }) {
  const canReport = Boolean(reportNum);
  const canStatus = Boolean(appN);
  els.actionPdf.classList.toggle("hidden", !canReport);
  els.actionCover.classList.toggle("hidden", !canReport);
  els.actionStatus.classList.toggle("hidden", !canStatus);
  els.actionApply.classList.toggle("hidden", !url);
  els.resultActions.classList.toggle("hidden", !canReport && !canStatus && !url);
  resetActionPanel();
  if (canReport) {
    els.actionPdf.onclick = () => runPdf(reportNum, appN);
    els.actionCover.onclick = () => runCover(reportNum);
  }
  if (canStatus) {
    els.actionStatus.onclick = () => showStatusSelect(appN);
  }
  if (url) {
    els.actionApply.onclick = () => runApplyDraft(url, tabId);
  }
}

// ── action panel (pdf / cover / status / apply-draft, all native-in-panel) ─
function resetActionPanel() {
  actionController?.abort();
  actionController = null;
  els.actionPanel.classList.add("hidden");
  els.actionPanelStatus.classList.add("hidden");
  els.actionPanelError.classList.add("hidden");
  els.actionPanelBody.textContent = "";
}
let awaitingDecisions = false;

function showActionBusy(label) {
  els.actionPanel.classList.remove("hidden");
  els.actionPanelStatus.classList.remove("hidden");
  els.actionPanelError.classList.add("hidden");
  els.actionPanelBody.textContent = "";
  els.actionPanelStatusText.textContent = label;
}
function showActionError(msg) {
  actionController = null;
  els.actionPanelStatus.classList.add("hidden");
  els.actionPanelError.classList.remove("hidden");
  els.actionPanelError.textContent = msg;
}
function panelLink(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "panel-link";
  a.textContent = label;
  return a;
}

/**
 * Render the per-item add/drop question and resume the run once answered.
 *
 * Per ITEM, never all-or-nothing: a tailoring pass typically surfaces one claim
 * that is genuinely true and undocumented alongside others that are only the job
 * description talking, so one verdict for the whole list is the wrong shape.
 */
function showDecisions({ reportNum, format, items }, appN) {
  els.actionPanelStatus.classList.add("hidden");
  els.actionPanelBody.textContent = "";

  const intro = document.createElement("p");
  intro.className = "decisions-intro";
  intro.textContent = `${items.length} thing${items.length === 1 ? "" : "s"} on this CV ${items.length === 1 ? "isn't" : "aren't"} in your cv.md. Keep or drop each:`;
  els.actionPanelBody.appendChild(intro);

  // Default DROP, not keep. The user is being asked precisely because cv.md
  // does not support these, so an unanswered item must not ride onto the CV.
  const chosen = new Map(items.map((t) => [t, "drop"]));

  for (const tag of items) {
    const row = document.createElement("div");
    row.className = "decision-row";
    const label = document.createElement("span");
    label.className = "decision-tag";
    label.textContent = tag;
    const group = document.createElement("span");
    group.className = "decision-actions";
    for (const [action, text] of [["add", "Keep"], ["drop", "Drop"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.className = "decision-btn" + (chosen.get(tag) === action ? " selected" : "");
      b.onclick = () => {
        chosen.set(tag, action);
        for (const sib of group.querySelectorAll(".decision-btn")) sib.classList.remove("selected");
        b.classList.add("selected");
      };
      group.appendChild(b);
    }
    row.append(label, group);
    els.actionPanelBody.appendChild(row);
  }

  const go = document.createElement("button");
  go.type = "button";
  go.className = "decision-apply";
  go.textContent = "Apply and make the PDF";
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "Rendering…";
    try {
      const res = await fetch(`${serverUrl}/api/cv-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportNum,
          format,
          decisions: [...chosen].map(([tag, action]) => ({ tag, action })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showActionError(data.error || "Could not finish the CV.");
        return;
      }
      awaitingDecisions = false;
      els.actionPanelBody.textContent = "";
      els.actionPanelBody.appendChild(
        panelLink(`${serverUrl}/pipeline/${appN || reportNum}`, "Generated — view tailored CV →"),
      );
      // Kept claims are NOT written to cv.md here: "keep it on this CV" and
      // "add it to my permanent CV" are different decisions, and the second one
      // goes through add-entry.mjs's own confirm step.
      if (data.pendingCvAdditions?.length) {
        const note = document.createElement("p");
        note.className = "decisions-intro";
        note.textContent = `Kept on this CV but still not in cv.md: ${data.pendingCvAdditions.join(", ")}`;
        els.actionPanelBody.appendChild(note);
      }
    } catch {
      showActionError("Could not reach career-ops to finish the CV.");
    }
  };
  els.actionPanelBody.appendChild(go);
}

function runPdf(reportNum, appN) {
  resetActionPanel();
  awaitingDecisions = false;
  showActionBusy("Starting…");
  actionController = new AbortController();
  runJob({
    serverUrl,
    cliId,
    kind: "pdf",
    input: reportNum,
    signal: actionController.signal,
    onStatus: (label) => { els.actionPanelStatusText.textContent = label; },
    onDecisions: (ev) => {
      // The run stopped BEFORE rendering: the tailored CV asserts competencies
      // cv.md does not support (modes/pdf.md step 14a). Nothing was rendered,
      // so this replaces the result rather than annotating it.
      awaitingDecisions = true;
      showDecisions(ev, appN);
    },
    onDone: (d) => {
      // A run that stopped to ask ends with done too — its panel is already
      // showing the question and must not be overwritten with a success link
      // for a PDF that was never rendered.
      if (awaitingDecisions || d?.awaitingDecisions) return;
      actionController = null;
      els.actionPanelStatus.classList.add("hidden");
      // No reliable company slug is available client-side to hit /api/cv-pdf
      // directly (guessing wrong would show someone else's tailored CV) — the
      // report page's own "View tailored CV" link already resolves it correctly.
      // /pipeline/{n} navigates by the tracker ROW number (appN), not the
      // report file number — see wireResultActions's header comment.
      els.actionPanelBody.appendChild(panelLink(`${serverUrl}/pipeline/${appN || reportNum}`, "Generated — view tailored CV →"));
    },
    onError: showActionError,
    onAborted: () => showActionError("Stopped."),
  });
}

function runCover(reportNum) {
  resetActionPanel();
  showActionBusy("Starting…");
  actionController = new AbortController();
  runJob({
    serverUrl,
    cliId,
    kind: "cover",
    input: reportNum,
    signal: actionController.signal,
    onStatus: (label) => { els.actionPanelStatusText.textContent = label; },
    onDone: ({ text }) => {
      actionController = null;
      els.actionPanelStatus.classList.add("hidden");
      const draft = document.createElement("div");
      draft.className = "draft-text";
      draft.textContent = (text || "").trim() || "No draft text was returned.";
      els.actionPanelBody.appendChild(draft);
    },
    onError: showActionError,
    onAborted: () => showActionError("Stopped."),
  });
}

function showStatusSelect(appN) {
  resetActionPanel();
  els.actionPanel.classList.remove("hidden");
  const wrap = document.createElement("div");
  wrap.className = "status-row-inline";
  const select = document.createElement("select");
  select.id = "status-select";
  for (const s of CANONICAL_STATES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  }
  const saved = document.createElement("span");
  saved.id = "status-saved";
  wrap.appendChild(select);
  wrap.appendChild(saved);
  els.actionPanelBody.appendChild(wrap);
  select.addEventListener("change", async () => {
    saved.textContent = "Saving…";
    try {
      const res = await fetch(`${serverUrl}/api/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: appN, status: select.value }),
      });
      if (res.ok) {
        saved.textContent = "Saved ✓";
        return;
      }
      let msg = "Failed to save.";
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      saved.textContent = msg;
      saved.style.color = "#991b1b";
    } catch {
      saved.textContent = "career-ops isn't reachable.";
      saved.style.color = "#991b1b";
    }
  });
}

function renderApplyFields(fields, answers) {
  const list = document.createElement("div");
  list.className = "field-list";
  for (const f of fields) {
    const a = answers[f.id];
    const item = document.createElement("div");
    item.className = "field-item";
    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = f.label || f.id;
    if (a?.needs_confirmation) {
      const badge = document.createElement("span");
      badge.className = "field-badge";
      badge.textContent = "needs confirmation";
      label.appendChild(badge);
    }
    const value = document.createElement("div");
    const v = String(a?.value ?? "").trim();
    value.className = v ? "field-value" : "field-value empty";
    value.textContent = v || "(no draft)";
    item.appendChild(label);
    item.appendChild(value);
    list.appendChild(item);
  }
  return list;
}

// Shared by runApplyDraft (result-card button) and draftFormForUrl (a
// screenshot's "draft form answers" quick action) — both drive the same
// draftApplication() and just need the outcome rendered into a different
// container (the action panel vs. a chat bubble).
function renderApplyOutcome(container, url, { fields, answers, needsDrive, truncated }) {
  if (needsDrive) {
    const note = document.createElement("div");
    note.textContent = "This form needs a few clicks before its fields show up (multi-step) — open it in career-ops instead:";
    container.appendChild(note);
    const link = panelLink(`${serverUrl}/apply?url=${encodeURIComponent(url)}`, "Open in career-ops →");
    link.style.marginTop = "6px";
    link.style.display = "inline-block";
    container.appendChild(link);
    return;
  }
  if (truncated) {
    const warn = document.createElement("div");
    warn.className = "field-badge";
    warn.style.display = "inline-block";
    warn.style.marginBottom = "8px";
    warn.textContent = "Some answers may be missing (truncated)";
    container.appendChild(warn);
  }
  container.appendChild(renderApplyFields(fields, answers));
  const note = document.createElement("div");
  note.style.marginTop = "8px";
  note.style.color = "#6b7280";
  note.style.fontSize = "11px";
  note.textContent = "Draft only — copy these into the real form yourself, or let career-ops fill it in for you:";
  container.appendChild(note);
  const link = panelLink(`${serverUrl}/apply?url=${encodeURIComponent(url)}`, "Open in career-ops to fill it →");
  link.style.marginTop = "6px";
  link.style.display = "inline-block";
  container.appendChild(link);
}

// If the caller doesn't already know which tab a URL lives in, check whether
// it happens to be open somewhere — reading that tab's live DOM (real
// session/cookies, no extra browser) beats /api/apply/session's fallback
// (a fresh, session-less Chrome) whenever we can reach it. A plain URL with
// no wildcard is itself a valid match pattern for tabs.query.
async function resolveTabIdForUrl(url) {
  try {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  } catch {
    return undefined;
  }
}

async function runApplyDraft(url, tabId) {
  resetActionPanel();
  showActionBusy("Opening the form…");
  actionController = new AbortController();
  const resolvedTabId = tabId ?? (await resolveTabIdForUrl(url));
  draftApplication({
    serverUrl,
    cliId,
    url,
    tabId: resolvedTabId,
    signal: actionController.signal,
    onStatus: (label) => { els.actionPanelStatusText.textContent = label; },
    onDone: (outcome) => {
      actionController = null;
      els.actionPanelStatus.classList.add("hidden");
      renderApplyOutcome(els.actionPanelBody, url, outcome);
    },
    onError: showActionError,
    onAborted: () => showActionError("Stopped."),
  });
}

// A screenshot's "draft form answers for this page" quick action, the
// landing buttons, and a pasted/chat-given link all funnel through here —
// same draftApplication() call as runApplyDraft, rendered into a chat bubble
// instead of the result-card's action panel since any of those can happen
// with no evaluation (and no result-card) on screen at all.
async function draftFormForUrl(url, tabId) {
  const div = addMessage("assistant", `Reading the form at ${url}…`);
  const controller = new AbortController();
  const resolvedTabId = tabId ?? (await resolveTabIdForUrl(url));
  draftApplication({
    serverUrl,
    cliId,
    url,
    tabId: resolvedTabId,
    signal: controller.signal,
    onStatus: (label) => { div.textContent = label; },
    onDone: (outcome) => {
      div.textContent = "";
      renderApplyOutcome(div, url, outcome);
      els.scrollArea.scrollTop = els.scrollArea.scrollHeight;
    },
    onError: (msg) => { div.textContent = `Error: ${msg}`; },
    onAborted: () => { div.textContent = "Stopped."; },
  });
}

els.actionPanelStop.addEventListener("click", () => actionController?.abort());

els.evaluateAnyway.addEventListener("click", () => startEvaluate(activeCapture));
els.retry.addEventListener("click", () => activeCapture && startEvaluate(activeCapture));
els.stopEval.addEventListener("click", () => evalController?.abort());

// ── chat (follow-up questions, unchanged behavior) ──────────────────────
function addMessage(role, text, imageDataUrl) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (imageDataUrl) {
    const img = document.createElement("img");
    img.className = "msg-img";
    img.src = imageDataUrl;
    div.appendChild(img);
  }
  // A plain text-content assignment ON THE OUTER div (not a child) is how the
  // streaming assistant reply keeps updating itself below — a bare string
  // here would otherwise wipe the image node a user message just got.
  const textNode = document.createTextNode(text);
  div.appendChild(textNode);
  els.messages.appendChild(div);
  els.scrollArea.scrollTop = els.scrollArea.scrollHeight;
  return div;
}

// ── image attachments (file picker, paste, or a tab screenshot) ────────────
// sourceUrl is set only for screenshots (background.js's context-menu capture
// hands back the tab's URL alongside the image) — it's what lets a captured
// application form offer "draft answers for this page" instead of being just
// a picture, by reusing the SAME apply-draft flow the result-card's "Fill out
// form" button already runs (lib/apply-draft.js) rather than a new one.
function setAttachment(dataUrl, sourceUrl, sourceTabId) {
  pendingAttachment = { dataUrl, sourceUrl, sourceTabId };
  els.attachmentThumb.src = dataUrl;
  els.attachmentPreview.classList.remove("hidden");
  els.attachmentDraftForm.classList.toggle("hidden", !sourceUrl);
}
function clearAttachment() {
  pendingAttachment = null;
  els.attachmentThumb.src = "";
  els.attachmentPreview.classList.add("hidden");
  els.attachmentDraftForm.classList.add("hidden");
  els.fileInput.value = "";
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  try {
    setAttachment(await fileToDataUrl(file));
  } catch {
    /* unreadable file — leave no attachment rather than a broken one */
  }
});
els.attachmentRemove.addEventListener("click", clearAttachment);
els.attachmentDraftForm.addEventListener("click", () => {
  if (pendingAttachment?.sourceUrl) draftFormForUrl(pendingAttachment.sourceUrl, pendingAttachment.sourceTabId);
});

els.screenshotBtn.addEventListener("click", async () => {
  try {
    // A button click INSIDE the side panel isn't a top-level user gesture, so
    // Chrome refuses activeTab here even though it's declared in the manifest —
    // captureVisibleTab only works from a genuine gesture like a context-menu
    // click (see background.js). Still worth trying first in case a future
    // Chrome version changes this; the catch below is the expected path today.
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
    if (dataUrl) setAttachment(dataUrl);
  } catch {
    addMessage("assistant", "Chrome only allows a screenshot from a page-level click, not from inside this panel — right-click anywhere on the page and choose \"career-ops: attach a screenshot of this page\".");
  }
});

function handleScreenshot(shot) {
  if (shot?.dataUrl) setAttachment(shot.dataUrl, shot.url, shot.tabId);
}

els.input.addEventListener("paste", async (e) => {
  const item = Array.from(e.clipboardData?.items || []).find((it) => it.type.startsWith("image/"));
  if (!item) return; // let normal text paste through
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  try {
    setAttachment(await fileToDataUrl(file));
  } catch {
    /* unreadable clipboard image — ignore */
  }
});

function addActionLink(label, onClick) {
  const a = document.createElement("div");
  a.className = "action-link";
  a.textContent = label;
  a.addEventListener("click", onClick);
  els.messages.appendChild(a);
  els.scrollArea.scrollTop = els.scrollArea.scrollHeight;
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
  // "text" is a pasted JD with no URL (the assistant can't fetch it — it comes
  // straight from the conversation instead); /api/run's evaluate prompt
  // branches on whether input looks like a URL, so either just flows through
  // as the same `input` string.
  const evalInput = args.url || args.text;
  if (env.id === "evaluate" && evalInput) {
    const link = addActionLink(args.url ? `Evaluating ${args.url}…` : "Evaluating the pasted job description…", () => {});
    runEvaluate({
      serverUrl,
      cliId,
      url: evalInput,
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
  // "apply" is the assistant's own action for "read this posting's form" —
  // it already fires when you paste a link and ask it to apply/fill it out
  // (see SYSTEM_PREAMBLE in api/assistant/route.ts). Run it natively with
  // draftFormForUrl (same code the landing button and a screenshot's
  // "draft form answers" link use) instead of just opening a career-ops tab.
  if (env.id === "apply" && args.url) {
    draftFormForUrl(args.url);
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
  const image = pendingAttachment?.dataUrl;
  try {
    addMessage("user", message, image);
    clearAttachment();
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
        body: JSON.stringify({ message, cliId, history: history.slice(-8), pageContext, image }),
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
  // An attachment with no typed text still needs SOME message text — the
  // backend requires `message` — so default to something the model can act on.
  if (!v && !pendingAttachment) return;
  els.input.value = "";
  sendChat(v || "What do you see in this image?");
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
  // Capturing a posting no longer auto-starts an evaluation — it stops here
  // and shows action buttons so the user decides what to do with it.
  setEvalState(capture.isListingUrl ? "listing-warning" : "captured");
}

els.captureEvaluate.addEventListener("click", () => startEvaluate(activeCapture));
els.captureFill.addEventListener("click", () => activeCapture && draftFormForUrl(activeCapture.url, activeCapture.tabId));

/** Current tab's URL for the landing buttons — undefined when there isn't one
 *  (chrome:// pages, an extension page, a tab mid-navigation). */
async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url && /^https?:\/\//i.test(tab.url) ? tab : undefined;
}

els.landingEvaluate.addEventListener("click", async () => {
  const tab = await activeTabUrl();
  if (!tab) {
    addMessage("assistant", "The active tab isn't a page I can evaluate (needs an http(s) URL).");
    return;
  }
  // isListingUrl defaults false here — the landing button is a deliberate
  // "evaluate whatever's on this tab" click, not the content script's own
  // listing-page heuristic (lib/extract.js), so it's not re-run client-side.
  handleCapture({ url: tab.url, title: tab.title || "", text: "", isListingUrl: false, tabId: tab.id });
});

els.landingApply.addEventListener("click", async () => {
  const tab = await activeTabUrl();
  if (!tab) {
    addMessage("assistant", "The active tab isn't a page I can read a form from (needs an http(s) URL).");
    return;
  }
  draftFormForUrl(tab.url, tab.id);
});

function submitLandingUrl() {
  const url = els.landingUrlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    addMessage("assistant", "That doesn't look like a link (needs to start with http:// or https://).");
    return;
  }
  els.landingUrlInput.value = "";
  draftFormForUrl(url);
}
els.landingUrlFill.addEventListener("click", submitLandingUrl);
els.landingUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitLandingUrl();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.pendingCapture?.newValue) {
    const capture = changes.pendingCapture.newValue;
    chrome.storage.session.remove("pendingCapture");
    handleCapture(capture);
  }
  if (changes.pendingScreenshot?.newValue) {
    const shot = changes.pendingScreenshot.newValue;
    chrome.storage.session.remove("pendingScreenshot");
    handleScreenshot(shot);
  }
});

// ── init ─────────────────────────────────────────────────────────────────
(async function init() {
  const cfg = await chrome.storage.local.get(["serverUrl", "cliId"]);
  serverUrl = (cfg.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
  cliId = cfg.cliId || "";

  const { pendingCapture, pendingScreenshot } = await chrome.storage.session.get(["pendingCapture", "pendingScreenshot"]);
  await chrome.storage.session.remove(["pendingCapture", "pendingScreenshot"]);

  if (pendingScreenshot) handleScreenshot(pendingScreenshot);

  if (!pendingCapture) {
    setEvalState("idle");
    if (!cliId) addMessage("assistant", "No CLI configured yet — open the extension's Options page to pick one.");
    return;
  }

  handleCapture(pendingCapture);
})();
