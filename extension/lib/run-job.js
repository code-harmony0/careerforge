// extension/lib/run-job.js
// Generic driver for the same /api/run NDJSON contract run-evaluate.js drives,
// generalized over `kind` so pdf/cover can reuse it instead of forking the
// stream-parsing logic. run-evaluate.js keeps its own copy (untouched) because
// it also does VERDICT-line parsing that the other two kinds don't need.
//
// callbacks:
//   onStatus(label)   — a short human-readable progress line
//   onText(fullText)  — the growing accumulated agent text (for kinds whose
//                       result IS the text, e.g. cover letters)
//   onDone({text, ...doneEvent})
//   onError(message)
//   onAborted()        — signal was aborted (user hit Stop); not an error
export async function runJob({ serverUrl, cliId, kind, input, signal, onStatus, onText, onDone, onError, onAborted }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, input, cliId }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      onAborted?.();
      return;
    }
    onError("Could not reach career-ops to start this.");
    return;
  }
  if (!res.ok || !res.body) {
    let msg = "Failed to start.";
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    onError(msg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
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
        if (ev.type === "tool") {
          onStatus(`Reading ${ev.name}…`);
        } else if (ev.type === "status") {
          onStatus(String(ev.label || "Working…"));
        } else if (ev.type === "text") {
          text += ev.text;
          onText?.(text);
        } else if (ev.type === "done") {
          onDone({ ...ev, text });
          return;
        } else if (ev.type === "error") {
          onError(ev.msg || "Failed.");
          return;
        }
      }
    }
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) {
      onAborted?.();
      return;
    }
    onError("Connection lost.");
    return;
  }
  onDone({ text });
}
