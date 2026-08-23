// extension/lib/apply-draft.js
// A scoped-down, read-only version of what web/src/components/apply-provider.tsx
// drives (read the form's fields → AI drafts an answer per field). It stops
// there: it never calls /api/apply/fill (the step that types into the real
// form and needs the user to review/edit each answer in that stateful UI
// first) — the panel only shows the drafted answers as text to copy.
//
// Two ways to get the fields, and draftApplication picks whichever fits:
//
//   tabId given  → message the content script in THAT tab (lib/extract-form.js)
//                  and read its live DOM directly. Same tab, same session,
//                  same login the user already has — no extra browser. This
//                  is the path whenever the target is a tab we can reach
//                  (the one that was captured, the active tab, or a pasted
//                  URL that happens to match an already-open tab).
//   tabId absent → fall back to /api/apply/session, which opens a SEPARATE,
//                  session-less Chrome via Playwright to fetch the URL cold.
//                  The only option for a URL that isn't open in any tab, but
//                  worth knowing: a login-gated or multi-step form can land
//                  somewhere different there, because it has none of the
//                  user's actual cookies.
//
// callbacks:
//   onStatus(label)
//   onFields(fields)                 — the extracted form fields, before answers exist
//   onDone({ fields, answers, needsDrive, truncated })
//   onError(message)
//   onAborted()
export async function draftApplication({ serverUrl, cliId, url, tabId, signal, onStatus, onFields, onDone, onError, onAborted }) {
  if (tabId != null) {
    return draftFromTab({ serverUrl, cliId, tabId, signal, onStatus, onFields, onDone, onError, onAborted });
  }
  return draftFromSession({ serverUrl, cliId, url, signal, onStatus, onFields, onDone, onError, onAborted });
}

async function draftFromTab({ serverUrl, cliId, tabId, signal, onStatus, onFields, onDone, onError, onAborted }) {
  const aborted = () => signal?.aborted;
  onStatus("Reading the form on this tab…");

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: "career-ops:extract-form" });
  } catch (e) {
    // "Could not establish connection. Receiving end does not exist." — by
    // far the most common cause: the tab was already open BEFORE the
    // extension was last reloaded at chrome://extensions. Chrome does not
    // retroactively inject new/updated content-script code into tabs that
    // were already loaded — only reloading (or re-navigating) THAT TAB picks
    // up the current content-script.js. A chrome:// page or a closed tab
    // throws the same way, so the message covers both.
    onError(`Couldn't read that tab — reload the JOB PAGE tab itself (not just the extension) and try again. (${e?.message || e})`);
    return;
  }
  if (aborted()) return onAborted?.();
  if (!resp?.ok) {
    onError(resp?.error || "Couldn't read the form on that tab.");
    return;
  }
  const { title, fields } = resp.form;
  if (!fields?.length) {
    onDone({ fields: [], answers: {}, needsDrive: true });
    return;
  }

  onFields?.(fields);
  const outcome = await runPrefill({ serverUrl, cliId, fields, title, signal, onStatus });
  if (aborted()) return onAborted?.();
  if (outcome.aborted) return onAborted?.();
  if (outcome.error) {
    onError(outcome.error);
    return;
  }
  onDone({ fields, answers: outcome.answers, needsDrive: false, truncated: outcome.truncated });
}

async function draftFromSession({ serverUrl, cliId, url, signal, onStatus, onFields, onDone, onError, onAborted }) {
  const aborted = () => signal?.aborted;

  let session;
  onStatus("Opening the form…");
  try {
    const res = await fetch(`${serverUrl}/api/apply/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, cliId }),
      signal,
    });
    session = await res.json().catch(() => null);
    if (!res.ok || !session) {
      onError(session?.error || "Could not open the application form.");
      return;
    }
  } catch (e) {
    if (e?.name === "AbortError" || aborted()) return onAborted?.();
    onError("Could not reach career-ops to open the form.");
    return;
  }

  if (session.needsDrive || !session.fields?.length) {
    // A multi-step form (e.g. behind a "Continue" click) needs the interactive
    // driving the web app's ApplyView does — this read-only panel can't do
    // that, so hand it off there instead of pretending it has fields.
    void closeSession(serverUrl, session.id);
    onDone({ fields: [], answers: {}, needsDrive: true });
    return;
  }

  onFields?.(session.fields);
  const outcome = await runPrefill({ serverUrl, cliId, sessionId: session.id, signal, onStatus });
  void closeSession(serverUrl, session.id);
  if (aborted()) return onAborted?.();
  if (outcome.aborted) return onAborted?.();
  if (outcome.error) {
    onError(outcome.error);
    return;
  }
  onDone({ fields: session.fields, answers: outcome.answers, needsDrive: false, truncated: outcome.truncated });
}

// Shared by both paths — drafting was always read-only/no-browser-access on
// the server regardless of where the fields came from (see prefill's own
// header), so it only ever needs sessionId OR fields+title, plus cliId.
async function runPrefill({ serverUrl, cliId, sessionId, fields, title, signal, onStatus }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/apply/prefill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId, cliId } : { fields, title, cliId }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) return { aborted: true };
    return { error: "Could not reach career-ops to draft answers." };
  }
  if (!res.ok || !res.body) return { error: "Drafting the answers failed to start." };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let outcome = null;
  try {
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
        if (ev.t === "log") onStatus(String(ev.m || "Working…"));
        else if (ev.t === "done") outcome = { answers: ev.answers || {}, truncated: Boolean(ev.truncated) };
        else if (ev.t === "error") outcome = { error: ev.m || "Drafting failed." };
      }
    }
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) return { aborted: true };
    return { error: "Connection lost while drafting answers." };
  }

  return outcome || { error: "Drafting the answers failed." };
}

function closeSession(serverUrl, sessionId) {
  return fetch(`${serverUrl}/api/apply/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}
