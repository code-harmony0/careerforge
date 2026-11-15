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
import { parseVerdict, scoreTone } from "./lib/verdict.js";
import {
  saveSession,
  loadSessions,
  getSession,
  deleteSession,
  clearAllSessions,
  getActiveSessionId,
  setActiveSessionId,
  createSessionId,
  deriveTitle,
  formatSessionTime,
  findEvaluatedSession,
  isSameJobUrl,
  normalizeJobUrl,
} from "./lib/history-store.js";

// Source of truth: web/src/lib/format.ts's CANONICAL_STATES / templates/states.yml.
const CANONICAL_STATES = ["Evaluated", "Applied", "Responded", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"];

const DEFAULT_SERVER = "http://localhost:3000";

const els = {
  btnNewChat: document.getElementById("btn-new-chat"),
  btnHistory: document.getElementById("btn-history"),
  historyBadge: document.getElementById("history-badge"),
  historyView: document.getElementById("history-view"),
  btnCloseHistory: document.getElementById("btn-close-history"),
  historySearch: document.getElementById("history-search"),
  historyList: document.getElementById("history-list"),
  btnClearHistory: document.getElementById("btn-clear-history"),
  historyClearConfirm: document.getElementById("history-clear-confirm"),
  btnConfirmClear: document.getElementById("btn-confirm-clear"),
  btnCancelClear: document.getElementById("btn-cancel-clear"),
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
  cachedNotice: document.getElementById("cached-notice"),
  btnReevaluate: document.getElementById("btn-reevaluate"),
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
let sessionMessages = [];
let currentSessionId = null;
let currentSession = null;
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
  if (state !== "result") hideCachedNotice();
}

function showCachedNotice() {
  if (els.cachedNotice) els.cachedNotice.classList.remove("hidden");
}

function hideCachedNotice() {
  if (els.cachedNotice) els.cachedNotice.classList.add("hidden");
}

function renderCapture(capture) {
  els.captureTitle.textContent = capture.title || "(untitled page)";
  els.captureUrl.textContent = capture.url;
}

/**
 * Check if the backend pipeline (tracker / reports) has an existing evaluation
 * for this URL, in case it was evaluated outside this browser session.
 */
async function findRemoteEvaluatedApplication(url) {
  if (!url || !serverUrl) return null;
  try {
    const res = await fetch(`${serverUrl}/api/pipeline`);
    if (!res.ok) return null;
    const data = await res.json();
    const apps = Array.isArray(data.applications) ? data.applications : [];
    const matched = apps.find((app) => {
      if (app.url && isSameJobUrl(app.url, url)) return true;
      if (app.applyLink && isSameJobUrl(app.applyLink, url)) return true;
      return false;
    });
    if (!matched) return null;

    const scoreNum = parseFloat(matched.score);
    if (Number.isNaN(scoreNum) || scoreNum <= 0) {
      // Scanned or in pipeline without a score — not evaluated yet!
      return null;
    }
    const appN = parseInt(matched.n, 10) || matched.n;
    const repMatch = typeof matched.report === "string" ? matched.report.match(/\[(\d+)\]/) : null;
    const reportNum = repMatch ? parseInt(repMatch[1], 10) : appN;
    const reportUrl = `${serverUrl}/pipeline/${appN}`;

    let summary = matched.notes || "";
    try {
      const repRes = await fetch(`${serverUrl}/api/report?n=${reportNum}`);
      if (repRes.ok) {
        const repData = await repRes.json();
        const content = repData?.report?.content || repData?.content;
        if (content) {
          const parsed = parseVerdict(content);
          if (parsed.summary) summary = parsed.summary;
        }
      }
    } catch {}

    return {
      score: scoreNum,
      summary,
      reportNum,
      appN,
      reportUrl,
      tone: scoreTone(scoreNum),
      company: matched.company,
      role: matched.role,
      status: matched.status,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the given job URL has already been evaluated before with a valid score,
 * checking local extension history first, then falling back to the backend pipeline.
 * Only returns an existing evaluation if a valid numeric score is present!
 */
async function checkExistingEvaluation(url) {
  if (!url) return null;

  // 1. Check local session history first (must have a valid score)
  const localSession = await findEvaluatedSession(url);
  if (localSession && typeof localSession.evalResult?.score === "number" && !Number.isNaN(localSession.evalResult.score) && localSession.evalResult.score > 0) {
    return { source: "local", session: localSession };
  }

  // 2. Check remote backend pipeline (tracker / reports — must have a valid score)
  const remote = await findRemoteEvaluatedApplication(url);
  if (remote && typeof remote.score === "number" && !Number.isNaN(remote.score) && remote.score > 0) {
    const session = {
      id: createSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: remote.company ? `${remote.company} — ${remote.role || "Evaluation"}` : deriveTitle({ capture: { url } }),
      capture: {
        url,
        title: remote.company && remote.role ? `${remote.company} — ${remote.role}` : "",
        text: "",
        isListingUrl: false,
      },
      evalState: "result",
      evalResult: {
        score: remote.score,
        summary: remote.summary,
        reportNum: remote.reportNum,
        appN: remote.appN,
        reportUrl: remote.reportUrl,
        tone: remote.tone,
      },
      messages: [],
      history: [],
    };
    await saveSession(session);
    return { source: "remote", session };
  }

  return null;
}

async function startEvaluate(capture, { force = false } = {}) {
  if (!cliId) {
    els.errorText.textContent = "No CLI configured yet — open the extension's Options page to pick one.";
    setEvalState("error");
    return;
  }

  // If already evaluated and not forcing a re-evaluation, show existing results immediately:
  if (!force && capture?.url) {
    const existing = await checkExistingEvaluation(capture.url);
    if (existing?.session) {
      await loadAndRestoreSession(existing.session);
      showCachedNotice();
      return;
    }
  }

  hideCachedNotice();
  els.resultActions.classList.add("hidden");
  setEvalState("evaluating");
  els.statusText.textContent = "Starting…";
  evalController = new AbortController();

  let jdText = capture?.text || "";
  if (!jdText && chrome.tabs && chrome.scripting) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      const targetTabId = capture?.tabId || (activeTab?.url === capture?.url ? activeTab?.id : null);
      if (targetTabId) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          func: () => document.body?.innerText || "",
        });
        if (result && result.trim()) {
          jdText = result.trim().slice(0, 20000);
          if (capture) capture.text = jdText;
        }
      }
    } catch {
      // Fallback: server will fetch via headless WebFetch if not available from tab
    }
  }

  runEvaluate({
    serverUrl,
    cliId,
    url: capture.url,
    // The tab is already rendered and often login-walled; send its text so the
    // server never has to (and can't) re-fetch it.
    jdText,
    signal: evalController.signal,
    onStatus: (label) => {
      els.statusText.textContent = label;
    },
    onDone: ({ score, summary, reportNum, appN, reportUrl }) => {
      evalController = null;
      hideCachedNotice();
      if (score != null && typeof score === "number" && !Number.isNaN(score) && score > 0) {
        const tone = scoreTone(score);
        els.scoreBadge.className = tone;
        els.scoreBadge.textContent = `${score}/5`;
        els.resultSummary.textContent = summary || "";
        if (reportUrl) {
          els.openReport.href = reportUrl;
          els.openReport.classList.remove("hidden");
        } else {
          els.openReport.classList.add("hidden");
        }
        wireResultActions({ reportNum, appN, url: capture.url, tabId: capture.tabId });
        setEvalState("result");
        updateCurrentSession({
          capture,
          evalState: "result",
          evalResult: { score, summary, reportNum, appN, reportUrl, tone },
          title: deriveTitle({ capture, evalResult: { score, summary } }),
        });
      } else {
        els.errorText.textContent = "Evaluation finished, but no numeric score was produced. Please retry.";
        setEvalState("error");
        updateCurrentSession({ evalState: "error" });
      }
    },
    onError: (msg) => {
      evalController = null;
      els.errorText.textContent = msg;
      setEvalState("error");
      updateCurrentSession({ evalState: "error" });
    },
    onAborted: () => {
      evalController = null;
      els.errorText.textContent = "Evaluation stopped.";
      setEvalState("error");
      updateCurrentSession({ evalState: "error" });
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
    els.actionApply.onclick = () => runApplyDraft(url, tabId, { reportNum, appN });
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
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (href) chrome.tabs.create({ url: href });
  });
  return a;
}

/**
 * Render the per-item add/drop question and resume the run once answered.
 *
 * Per ITEM, never all-or-nothing: a tailoring pass typically surfaces one claim
 * that is genuinely true and undocumented alongside others that are only the job
 * description talking, so one verdict for the whole list is the wrong shape.
 */
function showDecisions({ reportNum, format, items }, appN, company) {
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
      if (company) {
        const link = panelLink(`${serverUrl}/api/cv-pdf?company=${encodeURIComponent(company)}`, "📄 Download tailored CV");
        link.className = "cv-download-link";
        els.actionPanelBody.appendChild(link);
      } else {
        els.actionPanelBody.appendChild(
          panelLink(`${serverUrl}/pipeline/${appN || reportNum}`, "Generated — view tailored CV →"),
        );
      }
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

async function runPdf(reportNum, appN) {
  resetActionPanel();
  const company = await lookupCompanyByReport(reportNum) || companyFromTitle(activeCapture?.title);
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
      showDecisions(ev, appN, company);
    },
    onDone: (d) => {
      // A run that stopped to ask ends with done too — its panel is already
      // showing the question and must not be overwritten with a success link
      // for a PDF that was never rendered.
      if (awaitingDecisions || d?.awaitingDecisions) return;
      actionController = null;
      els.actionPanelStatus.classList.add("hidden");
      if (company) {
        const link = panelLink(`${serverUrl}/api/cv-pdf?company=${encodeURIComponent(company)}`, "📄 Download tailored CV");
        link.className = "cv-download-link";
        els.actionPanelBody.appendChild(link);
      } else {
        els.actionPanelBody.appendChild(panelLink(`${serverUrl}/pipeline/${appN || reportNum}`, "Generated — view tailored CV →"));
      }
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
  if (appN) {
    fetch(`${serverUrl}/api/report?n=${encodeURIComponent(appN)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.app?.status && CANONICAL_STATES.includes(data.app.status)) {
          select.value = data.app.status;
        }
      })
      .catch(() => {});
  }
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
function renderApplyOutcome(container, url, { fields, answers, needsDrive, truncated }, tabId, cvCompany) {
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

  // ── auto-fill button ─────────────────────────────────────────────────
  // ALWAYS shown — the whole point is filling from the extension itself.
  // If we already know the tabId great; otherwise we resolve the active
  // tab at click time (covers pasted URLs and session-based drafts where
  // tabId wasn't available when the draft started).
  const fillBtn = document.createElement("button");
  fillBtn.type = "button";
  fillBtn.className = "fill-form-btn";
  fillBtn.innerHTML = '<span class="fill-icon">✨</span> Fill form on this page';
  const fillStatus = document.createElement("div");
  fillStatus.className = "fill-status hidden";
  fillBtn.addEventListener("click", async () => {
    fillBtn.disabled = true;
    fillBtn.textContent = "Filling…";
    fillStatus.className = "fill-status hidden";
    fillStatus.textContent = "";
    // Remove any previous error details.
    fillStatus.querySelectorAll(".fill-error-detail").forEach((el) => el.remove());

    // Build the answers map keyed by co* field IDs.
    const answersMap = {};
    for (const f of fields) {
      const a = answers[f.id];
      if (a && (a.value ?? "").trim()) {
        answersMap[f.id] = { value: String(a.value).trim(), label: f.label || f.id, type: f.type || "text" };
      }
    }
    if (Object.keys(answersMap).length === 0) {
      fillStatus.className = "fill-status fill-error";
      fillStatus.textContent = "No drafted answers to fill — try pre-filling from your CV first.";
      fillBtn.disabled = false;
      fillBtn.innerHTML = '<span class="fill-icon">✨</span> Fill form on this page';
      return;
    }

    // Resolve the target tab: use the pre-resolved tabId, or find the
    // active tab (the one the user is looking at right now).
    let targetTabId = tabId;
    if (targetTabId == null) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && /^https?:\/\//i.test(activeTab.url || "")) {
          targetTabId = activeTab.id;
        }
      } catch {
        /* no active tab reachable */
      }
    }
    if (targetTabId == null) {
      fillStatus.className = "fill-status fill-error";
      fillStatus.textContent = "No reachable tab — open the application form in a tab first, then try again.";
      fillBtn.disabled = false;
      fillBtn.innerHTML = '<span class="fill-icon">✨</span> Fill form on this page';
      return;
    }

    // Helper: send the fill message, auto-injecting content scripts if needed.
    async function sendFillMessage(tid, msg) {
      try {
        return await chrome.tabs.sendMessage(tid, msg);
      } catch {
        // Content scripts not loaded — inject and retry once.
        await chrome.scripting.executeScript({
          target: { tabId: tid },
          files: ["lib/extract.js", "lib/extract-form.js", "lib/fill-form.js", "content-script.js"],
        });
        await new Promise((r) => setTimeout(r, 200));
        return await chrome.tabs.sendMessage(tid, msg);
      }
    }

    try {
      const resp = await sendFillMessage(targetTabId, { type: "career-ops:fill-form", answers: answersMap });
      if (!resp?.ok) {
        fillStatus.className = "fill-status fill-error";
        fillStatus.textContent = resp?.error || "Couldn't fill — reload the job page tab and try again.";
      } else {
        const r = resp.results;
        if (r.filled > 0 && r.skipped === 0) {
          fillStatus.className = "fill-status fill-success";
          fillStatus.textContent = `Filled ${r.filled} field${r.filled === 1 ? "" : "s"} ✓ — review and submit the form yourself.`;
        } else if (r.filled > 0) {
          fillStatus.className = "fill-status fill-partial";
          fillStatus.textContent = `Filled ${r.filled}/${r.filled + r.skipped} fields — ${r.skipped} need manual attention.`;
        } else {
          fillStatus.className = "fill-status fill-error";
          fillStatus.textContent = "Couldn't fill any fields — the form may have changed. Try reloading the page.";
        }
        if (r.errors?.length) {
          for (const err of r.errors.slice(0, 5)) {
            const errLine = document.createElement("div");
            errLine.className = "fill-error-detail";
            errLine.textContent = `• ${err.label || err.id}: ${err.reason}`;
            fillStatus.appendChild(errLine);
          }
        }
      }
    } catch (e) {
      fillStatus.className = "fill-status fill-error";
      fillStatus.textContent = `Couldn't reach the tab — reload the job page tab and try again. (${e?.message || e})`;
    }
    fillBtn.disabled = false;
    fillBtn.innerHTML = '<span class="fill-icon">✨</span> Fill again';
  });
  container.appendChild(fillBtn);
  container.appendChild(fillStatus);

  // Safety reminder.
  const safety = document.createElement("div");
  safety.className = "fill-safety";
  safety.textContent = "🛡️ Never submits — you click Submit yourself.";
  container.appendChild(safety);

  if (cvCompany) {
    const dlLink = panelLink(`${serverUrl}/api/cv-pdf?company=${encodeURIComponent(cvCompany)}`, "📄 Download tailored CV");
    dlLink.className = "cv-download-link";
    container.appendChild(dlLink);
  }
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

// ── tailored CV check ───────────────────────────────────────────────────
// Before filling a form, check if a tailored CV exists for this company.
// Uses /api/cv-pdf (HEAD) — 200 means a PDF exists, 404 means it doesn't.
// Best-effort company extraction from the capture title when we don't have
// a tracker row to look up.
async function checkTailoredCv(company) {
  if (!company) return { exists: false, company: "" };
  try {
    const r = await fetch(`${serverUrl}/api/cv-pdf?company=${encodeURIComponent(company)}`, { method: "HEAD" });
    return { exists: r.ok, company };
  } catch {
    // Server unreachable — don't block the flow, just skip the check.
    return { exists: true, company };
  }
}

// Extract a best-effort company name from a page title.
// ATS titles: "Role @ Company" (Ashby), "Role at Company" (Lever/Greenhouse).
function companyFromTitle(title) {
  const t = (title || "").trim();
  if (!t) return "";
  const at = t.match(/@\s*([^|@]+?)\s*$/);
  if (at) return at[1].trim();
  const atWord = t.match(/\bat\s+([A-Z][\w&.\- ]+?)\s*$/);
  if (atWord) return atWord[1].trim();
  // "Company — Role" or "Company - Role"
  const dash = t.match(/^([^—–-]+?)\s*[—–-]\s*/);
  if (dash && dash[1].length < 60) return dash[1].trim();
  return "";
}

// Look up company from tracker via reportNum (server-side).
async function lookupCompanyByReport(reportNum) {
  if (!reportNum) return "";
  try {
    const r = await fetch(`${serverUrl}/api/report?n=${encodeURIComponent(reportNum)}`);
    if (!r.ok) return "";
    const data = await r.json();
    return data?.app?.company || "";
  } catch {
    return "";
  }
}

// Show a CV gate in the given container. Returns a promise that resolves to
// true (proceed with fill) or false (user chose to generate CV first).
function showCvGate(container, company, { reportNum, appN }) {
  return new Promise((resolve) => {
    const gate = document.createElement("div");
    gate.className = "cv-gate";
    gate.innerHTML = `
      <div class="cv-gate-icon">📄</div>
      <div class="cv-gate-title">No tailored resume found${company ? ` for ${company}` : ""}</div>
      <div class="cv-gate-hint">For best results, generate a tailored CV first — it personalizes your form answers and attaches your resume automatically.</div>
    `;
    const actions = document.createElement("div");
    actions.className = "cv-gate-actions";

    if (reportNum) {
      const genBtn = document.createElement("button");
      genBtn.type = "button";
      genBtn.className = "cv-gate-gen";
      genBtn.textContent = "📄 Generate tailored CV first";
      genBtn.addEventListener("click", () => {
        gate.remove();
        runPdf(reportNum, appN);
        resolve(false);
      });
      actions.appendChild(genBtn);
    }

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "cv-gate-skip";
    skipBtn.textContent = "Continue without CV →";
    skipBtn.addEventListener("click", () => {
      gate.remove();
      resolve(true);
    });
    actions.appendChild(skipBtn);
    gate.appendChild(actions);
    container.appendChild(gate);
  });
}

async function runApplyDraft(url, tabId, { reportNum, appN } = {}) {
  resetActionPanel();

  // ── tailored CV gate ───────────────────────────────────────────────────
  // Check if a tailored CV exists before opening the form.
  let cvCompany = null;
  const company = await lookupCompanyByReport(reportNum) || companyFromTitle(activeCapture?.title);
  if (company) {
    showActionBusy("Checking for tailored resume…");
    const cv = await checkTailoredCv(company);
    if (!cv.exists) {
      els.actionPanelStatus.classList.add("hidden");
      els.actionPanel.classList.remove("hidden");
      const proceed = await showCvGate(els.actionPanelBody, company, { reportNum, appN });
      if (!proceed) return; // user chose to generate CV first
      resetActionPanel();
    } else {
      cvCompany = company;
    }
  }

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
      renderApplyOutcome(els.actionPanelBody, url, outcome, resolvedTabId, cvCompany);
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
  // ── soft tailored CV check for the landing/chat flow ─────────────────
  // Best-effort: extract company from the capture or page title.
  let cvCompany = null;
  const company = companyFromTitle(activeCapture?.title || "");
  if (company) {
    const cv = await checkTailoredCv(company);
    if (!cv.exists) {
      const div = addMessage("assistant", "");
      div.innerHTML = `<strong>⚠️ No tailored resume found${company ? ` for ${company}` : ""}</strong><br><span style="font-size:11px;color:#6b7280">For best results, evaluate the posting first and generate a tailored CV. Continuing with your base CV…</span>`;
    } else {
      cvCompany = company;
    }
  }

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
      renderApplyOutcome(div, url, outcome, resolvedTabId, cvCompany);
      els.scrollArea.scrollTop = els.scrollArea.scrollHeight;
    },
    onError: (msg) => { div.textContent = `Error: ${msg}`; },
    onAborted: () => { div.textContent = "Stopped."; },
  });
}

els.actionPanelStop.addEventListener("click", () => actionController?.abort());

els.evaluateAnyway.addEventListener("click", () => startEvaluate(activeCapture));
els.retry.addEventListener("click", () => activeCapture && startEvaluate(activeCapture));
els.stopEval.addEventListener("click", () => {
  if (evalController) {
    evalController.abort();
    evalController = null;
  }
  els.errorText.textContent = "Evaluation stopped.";
  setEvalState("error");
  if (currentSession) {
    currentSession.evalState = "error";
    saveSession(currentSession);
  }
});

els.openReport.addEventListener("click", (e) => {
  e.preventDefault();
  if (els.openReport.href) {
    chrome.tabs.create({ url: els.openReport.href });
  }
});

// Ensure all external web links inside the sidepanel open in a new browser tab.
// In Chrome MV3 side panels, default anchor navigation is blocked/ignored.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || !a.href) return;
  if (/^https?:\/\//i.test(a.href)) {
    e.preventDefault();
    chrome.tabs.create({ url: a.href });
  }
});

// ── session persistence & history management ─────────────────────────────
async function updateCurrentSession(partial) {
  if (!currentSession) {
    if (!partial?.capture && !partial?.evalResult && !partial?.messages?.length && !partial?.history?.length) {
      return;
    }
    currentSessionId = currentSessionId || createSessionId();
    currentSession = {
      id: currentSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: "New Conversation",
      messages: sessionMessages,
      history: history,
      evalState: "idle",
      evalResult: null,
      capture: activeCapture,
    };
  }
  Object.assign(currentSession, partial, { updatedAt: Date.now() });
  if (partial.title) currentSession.title = partial.title;
  else if (!currentSession.title || currentSession.title === "New Conversation") {
    currentSession.title = deriveTitle(currentSession);
  }
  currentSession.messages = sessionMessages;
  currentSession.history = history;
  currentSession.capture = activeCapture;
  const saved = await saveSession(currentSession);
  currentSession = saved;
  currentSessionId = saved.id;
  updateHistoryBadge();
}

function resetActiveSessionState() {
  if (evalController) {
    evalController.abort();
    evalController = null;
  }
  if (actionController) {
    actionController.abort();
    actionController = null;
  }
  currentSessionId = null;
  currentSession = null;
  sessionMessages = [];
  history = [];
  activeCapture = null;
  resetActionPanel();
  clearAttachment();
  if (els.messages) els.messages.textContent = "";
  setEvalState("idle");
}

async function startNewSession() {
  resetActiveSessionState();
  currentSessionId = createSessionId();
  currentSession = {
    id: currentSessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "New Conversation",
    capture: null,
    evalState: "idle",
    evalResult: null,
    messages: [],
    history: [],
  };
  await setActiveSessionId(currentSessionId);
  closeHistoryView();
  updateHistoryBadge();
}

async function startNewSessionWithCapture(capture) {
  if (capture?.url) {
    const existing = await checkExistingEvaluation(capture.url);
    if (existing?.session) {
      activeCapture = capture;
      await loadAndRestoreSession(existing.session);
      showCachedNotice();
      return;
    }
  }

  resetActiveSessionState();
  currentSessionId = createSessionId();
  const state = capture.isListingUrl ? "listing-warning" : "captured";
  activeCapture = capture;
  renderCapture(capture);
  setEvalState(state);
  hideCachedNotice();

  currentSession = {
    id: currentSessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: deriveTitle({ capture }),
    capture,
    evalState: state,
    evalResult: null,
    messages: [],
    history: [],
  };
  await setActiveSessionId(currentSessionId);
  closeHistoryView();
  updateHistoryBadge();
}

async function loadAndRestoreSession(session) {
  if (!session) return;
  currentSessionId = session.id;
  currentSession = session;
  sessionMessages = [...(session.messages || [])];
  history = [...(session.history || [])];
  activeCapture = session.capture || null;
  await setActiveSessionId(session.id);

  resetActionPanel();
  clearAttachment();
  els.messages.textContent = "";

  if (session.capture) {
    renderCapture(session.capture);
  }

  if (session.evalResult && session.evalState === "result") {
    let { score, summary, reportNum, appN, reportUrl, tone } = session.evalResult;

    // Self-heal check if score is missing or invalid:
    if ((score == null || typeof score !== "number" || Number.isNaN(score) || score <= 0) && session.capture?.url) {
      try {
        const remote = await findRemoteEvaluatedApplication(session.capture.url);
        if (remote && typeof remote.score === "number" && !Number.isNaN(remote.score) && remote.score > 0) {
          score = remote.score;
          summary = summary || remote.summary;
          reportNum = reportNum || remote.reportNum;
          appN = appN || remote.appN;
          reportUrl = reportUrl || remote.reportUrl;
          tone = remote.tone;
          session.evalResult = { score, summary, reportNum, appN, reportUrl, tone };
          await saveSession(session);
        }
      } catch {}
    }

    if (score != null && typeof score === "number" && !Number.isNaN(score) && score > 0) {
      const effectiveTone = tone || scoreTone(score);
      els.scoreBadge.className = effectiveTone;
      els.scoreBadge.textContent = `${score}/5`;
      els.resultSummary.textContent = summary || "";
      if (reportUrl) {
        els.openReport.href = reportUrl;
        els.openReport.classList.remove("hidden");
      } else {
        els.openReport.classList.add("hidden");
      }
      wireResultActions({
        reportNum,
        appN,
        url: session.capture?.url,
        tabId: session.capture?.tabId,
      });
      setEvalState("result");
      showCachedNotice();
    } else {
      // Scanned or opened before, but has no valid score!
      // Do NOT show "No score" result card!
      hideCachedNotice();
      if (session.capture) {
        renderCapture(session.capture);
        setEvalState(session.capture.isListingUrl ? "listing-warning" : "captured");
      } else {
        setEvalState("idle");
      }
    }
  } else if (session.evalState && session.evalState !== "idle") {
    hideCachedNotice();
    if (session.evalState === "evaluating") {
      // An evaluation cannot continue running after sidepanel reload without an active controller!
      // Check if remote pipeline completed the evaluation while we were away:
      let restored = false;
      if (session.capture?.url) {
        try {
          const remote = await findRemoteEvaluatedApplication(session.capture.url);
          if (remote && typeof remote.score === "number" && !Number.isNaN(remote.score) && remote.score > 0) {
            session.evalResult = remote;
            session.evalState = "result";
            await saveSession(session);
            const tone = remote.tone || scoreTone(remote.score);
            els.scoreBadge.className = tone;
            els.scoreBadge.textContent = `${remote.score}/5`;
            els.resultSummary.textContent = remote.summary || "";
            if (remote.reportUrl) {
              els.openReport.href = remote.reportUrl;
              els.openReport.classList.remove("hidden");
            } else {
              els.openReport.classList.add("hidden");
            }
            wireResultActions({
              reportNum: remote.reportNum,
              appN: remote.appN,
              url: session.capture.url,
              tabId: session.capture.tabId,
            });
            setEvalState("result");
            showCachedNotice();
            restored = true;
          }
        } catch {}
      }
      if (!restored) {
        // If not completed remotely, reset to captured so it does not stay in a zombie spinning state!
        session.evalState = session.capture?.isListingUrl ? "listing-warning" : (session.capture ? "captured" : "idle");
        await saveSession(session);
        setEvalState(session.evalState);
      }
    } else {
      setEvalState(session.evalState);
    }
  } else {
    hideCachedNotice();
    setEvalState("idle");
  }

  if (Array.isArray(session.messages)) {
    for (const msg of session.messages) {
      addMessage(msg.role, msg.text, msg.imageDataUrl, /* isRestoring */ true);
    }
  }

  els.scrollArea.scrollTop = els.scrollArea.scrollHeight;
  closeHistoryView();
  updateHistoryBadge();
}

// ── history UI ───────────────────────────────────────────────────────────
async function openHistoryView() {
  els.historyView.classList.remove("hidden");
  if (els.historySearch) els.historySearch.value = "";
  if (els.historyClearConfirm) els.historyClearConfirm.classList.add("hidden");
  if (els.btnClearHistory) els.btnClearHistory.classList.remove("hidden");
  await renderHistoryList();
}

function closeHistoryView() {
  els.historyView.classList.add("hidden");
  if (els.historyClearConfirm) els.historyClearConfirm.classList.add("hidden");
  if (els.btnClearHistory) els.btnClearHistory.classList.remove("hidden");
}

async function toggleHistoryView() {
  if (els.historyView.classList.contains("hidden")) {
    await openHistoryView();
  } else {
    closeHistoryView();
  }
}

async function renderHistoryList(filterQuery = "") {
  const sessions = await loadSessions();
  els.historyList.textContent = "";

  if (els.btnClearHistory) {
    els.btnClearHistory.disabled = sessions.length === 0;
  }

  const q = filterQuery.trim().toLowerCase();
  const filtered = sessions.filter((s) => {
    if (!q) return true;
    if (s.title && s.title.toLowerCase().includes(q)) return true;
    if (s.capture?.url && s.capture.url.toLowerCase().includes(q)) return true;
    if (s.capture?.title && s.capture.title.toLowerCase().includes(q)) return true;
    if (s.evalResult?.summary && s.evalResult.summary.toLowerCase().includes(q)) return true;
    if (s.messages?.some((m) => m.text && m.text.toLowerCase().includes(q))) return true;
    return false;
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = q
      ? "No past sessions match your search."
      : "No saved conversations or evaluations yet. Evaluated job postings and chats will appear here so you can return to them anytime.";
    els.historyList.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const item = document.createElement("div");
    item.className = "history-item" + (s.id === currentSessionId ? " active" : "");
    item.dataset.id = s.id;

    const top = document.createElement("div");
    top.className = "history-item-top";

    const title = document.createElement("div");
    title.className = "history-item-title";
    title.textContent = s.title || "Untitled Session";
    top.appendChild(title);

    if (s.evalResult?.score != null) {
      const scoreBadge = document.createElement("span");
      scoreBadge.className = `history-item-score ${scoreTone(s.evalResult.score)}`;
      scoreBadge.textContent = `${s.evalResult.score}/5`;
      top.appendChild(scoreBadge);
    }
    item.appendChild(top);

    let snippetText = "";
    if (s.evalResult?.summary) {
      snippetText = s.evalResult.summary;
    } else if (s.messages?.length) {
      const lastMsg = s.messages[s.messages.length - 1];
      snippetText = `${lastMsg.role === "user" ? "You" : "AI"}: ${lastMsg.text || ""}`;
    } else if (s.capture?.url) {
      snippetText = s.capture.url;
    }
    if (snippetText) {
      const snippet = document.createElement("div");
      snippet.className = "history-item-snippet";
      snippet.textContent = snippetText;
      item.appendChild(snippet);
    }

    const btm = document.createElement("div");
    btm.className = "history-item-bottom";

    const time = document.createElement("span");
    time.className = "history-item-time";
    time.textContent = formatSessionTime(s.updatedAt || s.createdAt);
    btm.appendChild(time);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "history-item-del";
    delBtn.dataset.id = s.id;
    delBtn.title = "Delete this session";
    delBtn.setAttribute("aria-label", "Delete this session");
    delBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    `;
    btm.appendChild(delBtn);

    item.appendChild(btm);
    els.historyList.appendChild(item);
  }
}

async function handleDeleteSession(sessionId, delBtn) {
  const item = delBtn?.closest(".history-item");
  if (item) {
    item.style.opacity = "0.4";
    item.style.pointerEvents = "none";
  }
  try {
    await deleteSession(sessionId);
    if (sessionId === currentSessionId) {
      resetActiveSessionState();
    }
  } catch (err) {
    console.error("Failed to delete session:", err);
    if (item) {
      item.style.opacity = "";
      item.style.pointerEvents = "";
    }
  } finally {
    await renderHistoryList(els.historySearch?.value || "");
    await updateHistoryBadge();
  }
}

els.historyList.addEventListener("click", async (e) => {
  const delBtn = e.target.closest(".history-item-del");
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = delBtn.dataset.id;
    if (!sessionId) return;
    await handleDeleteSession(sessionId, delBtn);
    return;
  }

  const item = e.target.closest(".history-item");
  if (item) {
    const sessionId = item.dataset.id;
    if (!sessionId) return;
    const session = await getSession(sessionId);
    if (session) {
      await loadAndRestoreSession(session);
    }
  }
});

async function updateHistoryBadge() {
  try {
    const list = await loadSessions();
    if (els.historyBadge) {
      els.historyBadge.textContent = String(list.length);
      els.historyBadge.classList.toggle("hidden", list.length === 0);
    }
  } catch {}
}

// ── chat (follow-up questions, unchanged behavior) ──────────────────────
function addMessage(role, text, imageDataUrl, isRestoring = false) {
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

  if (!isRestoring) {
    sessionMessages.push({ role, text, imageDataUrl, timestamp: Date.now() });
    updateCurrentSession({ messages: sessionMessages });
  }

  return div;
}

function updateLastAssistantMessage(text) {
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    if (sessionMessages[i].role === "assistant") {
      sessionMessages[i].text = text;
      break;
    }
  }
  updateCurrentSession({ messages: sessionMessages });
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
    if (args.url) {
      const existing = await checkExistingEvaluation(args.url);
      if (existing?.session) {
        const res = existing.session.evalResult;
        const scoreStr = res?.score != null ? `${res.score}/5` : "Evaluated";
        const sumStr = res?.summary ? ` — ${res.summary}` : "";
        addActionLink(`Previously evaluated: ${scoreStr}${sumStr} (Click to view)`, async () => {
          await loadAndRestoreSession(existing.session);
          showCachedNotice();
        });
        if (res?.reportUrl) {
          addActionLink(`Open report → ${res.reportUrl}`, () => chrome.tabs.create({ url: res.reportUrl }));
        }
        return;
      }
    }
    const link = addActionLink(args.url ? `Evaluating ${args.url}…` : "Evaluating the pasted job description…", () => {});
    const capturedText = activeCapture?.url === evalInput ? activeCapture?.text : (!args.url ? evalInput : undefined);
    runEvaluate({
      serverUrl,
      cliId,
      url: evalInput,
      jdText: capturedText,
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
    updateLastAssistantMessage(assistantDiv.textContent);
    updateCurrentSession({ history });
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
async function handleCapture(capture) {
  activeCapture = capture;

  if (capture?.url) {
    const existing = await checkExistingEvaluation(capture.url);
    if (existing?.session) {
      await loadAndRestoreSession(existing.session);
      showCachedNotice();
      return;
    }
  }

  if (currentSession && (currentSession.evalResult || (sessionMessages && sessionMessages.length > 0))) {
    await startNewSessionWithCapture(capture);
    return;
  }

  renderCapture(capture);
  const state = capture.isListingUrl ? "listing-warning" : "captured";
  setEvalState(state);
  hideCachedNotice();
  updateCurrentSession({
    capture,
    evalState: state,
    title: deriveTitle({ capture }),
  });
}

els.btnHistory.addEventListener("click", toggleHistoryView);
els.btnCloseHistory.addEventListener("click", closeHistoryView);
els.btnNewChat.addEventListener("click", startNewSession);
els.historySearch.addEventListener("input", (e) => renderHistoryList(e.target.value));
els.btnClearHistory.addEventListener("click", () => {
  els.btnClearHistory.classList.add("hidden");
  els.historyClearConfirm.classList.remove("hidden");
});

els.btnCancelClear.addEventListener("click", () => {
  els.historyClearConfirm.classList.add("hidden");
  els.btnClearHistory.classList.remove("hidden");
});

els.btnConfirmClear.addEventListener("click", async () => {
  if (els.historyList) {
    els.historyList.style.opacity = "0.4";
    els.historyList.style.pointerEvents = "none";
  }
  try {
    resetActiveSessionState();
    await clearAllSessions();
  } catch (err) {
    console.error("Failed to clear history:", err);
  } finally {
    if (els.historyList) {
      els.historyList.style.opacity = "";
      els.historyList.style.pointerEvents = "";
    }
    els.historyClearConfirm.classList.add("hidden");
    els.btnClearHistory.classList.remove("hidden");
    await renderHistoryList(els.historySearch?.value || "");
    await updateHistoryBadge();
  }
});

els.captureEvaluate.addEventListener("click", () => startEvaluate(activeCapture));
els.captureFill.addEventListener("click", () => activeCapture && draftFormForUrl(activeCapture.url, activeCapture.tabId));
els.btnReevaluate?.addEventListener("click", () => {
  const cap = activeCapture || currentSession?.capture;
  if (cap) {
    startEvaluate(cap, { force: true });
  }
});

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
  await handleCapture({ url: tab.url, title: tab.title || "", text: "", isListingUrl: false, tabId: tab.id });
});

els.landingApply.addEventListener("click", async () => {
  const tab = await activeTabUrl();
  if (!tab) {
    addMessage("assistant", "The active tab isn't a page I can read a form from (needs an http(s) URL).");
    return;
  }
  draftFormForUrl(tab.url, tab.id);
});

async function submitLandingUrl() {
  const url = els.landingUrlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    addMessage("assistant", "That doesn't look like a link (needs to start with http:// or https://).");
    return;
  }
  els.landingUrlInput.value = "";
  const existing = await checkExistingEvaluation(url);
  if (existing?.session) {
    await loadAndRestoreSession(existing.session);
    showCachedNotice();
    return;
  }
  draftFormForUrl(url);
}
els.landingUrlFill.addEventListener("click", submitLandingUrl);
els.landingUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitLandingUrl();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session") return;
  if (changes.pendingCapture?.newValue) {
    const capture = changes.pendingCapture.newValue;
    chrome.storage.session.remove("pendingCapture");
    await handleCapture(capture);
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

  if (pendingCapture) {
    await handleCapture(pendingCapture);
    return;
  }

  // Restore the active or most recent session so closing the sidepanel never loses work:
  const activeId = await getActiveSessionId();
  let sessionToRestore = null;
  if (activeId) {
    sessionToRestore = await getSession(activeId);
  }
  if (!sessionToRestore) {
    const all = await loadSessions();
    if (all.length > 0) sessionToRestore = all[0];
  }

  if (sessionToRestore) {
    await loadAndRestoreSession(sessionToRestore);
  } else {
    setEvalState("idle");
    if (!cliId) addMessage("assistant", "No CLI configured yet — open the extension's Options page to pick one.");
  }
  updateHistoryBadge();
})();
