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
//   onDecisions({reportNum, format, items}) — the run stopped to ASK before
//                       rendering: the CV asserts competencies cv.md does not
//                       support. No PDF exists yet. Resolve per item and POST
//                       to /api/cv-review to resume.
//   onDone({text, ...doneEvent})
//   onError(message)
//   onAborted()        — signal was aborted (user hit Stop); not an error
/** "2m 14s" / "47s" — matches the web run log's fmtElapsed. */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export async function runJob({ serverUrl, cliId, kind, input, signal, onStatus, onText, onDecisions, onDone, onError, onAborted }) {
  const startedAt = Date.now();
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
  // The last real phase label, so a keepalive annotates the current phase
  // instead of overwriting it with a generic one.
  let phase = "Working…";
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
          phase = `Reading ${ev.name}…`;
          onStatus(phase);
        } else if (ev.type === "status") {
          phase = String(ev.label || "Working…");
          onStatus(phase);
        } else if (ev.type === "keepalive") {
          // The server sends these every 10s precisely BECAUSE the stream goes
          // silent: a pdf run on a CLI with no structured event stream (6 of the
          // 8 supported) emits no tool/status at all, and cvFilter swallows the
          // <<cv-html>> envelope that would otherwise arrive as text. Measured on
          // a live run: 80s, 8 keepalives, nothing else.
          //
          // Ignoring them left the panel pinned to its initial "Starting…" for
          // the whole multi-minute run, which reads as a hang and is why people
          // click again or give up on a run that is working fine. Liveness must
          // not depend on OPTIONAL events — the web run log survives the same
          // silence because it ticks its own elapsed clock (worker-card.tsx).
          onStatus(`${phase} · ${fmtElapsed(Date.now() - startedAt)}`);
        } else if (ev.type === "decisions") {
          // Emitted INSTEAD of a render. Handing it to onDone would report a
          // tailored CV that does not exist yet.
          onDecisions?.(ev);
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
