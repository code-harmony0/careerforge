// extension/lib/run-evaluate.js
// Drives the same /api/run contract web/src/components/jobs/job-store.tsx's
// startJob() uses — but reports STRUCTURED progress/result callbacks instead
// of a growing wall of raw text, so the side panel can render a real status
// line + result card instead of a chat bubble nobody can read the state of.
import { parseVerdict } from "./verdict.js";

// callbacks:
//   onStatus(label)              — a short human-readable progress line
//   onDone({score, summary, reportNum, reportUrl})
//   onError(message)
export async function runEvaluate({ serverUrl, cliId, url, onStatus, onDone, onError }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", input: url, cliId }),
    });
  } catch {
    onError("Could not reach career-ops to start the evaluation.");
    return;
  }
  if (!res.ok || !res.body) {
    let msg = "Evaluation failed to start.";
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
  let verdictLine = "";
  let reportNum;
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
          const full = text + ev.text;
          const vm = full.match(/VERDICT:[^\n]*/i);
          if (vm) verdictLine = vm[0];
          text = full.slice(-4000);
          onStatus("Writing the report…");
        } else if (ev.type === "done" && typeof ev.reportNum === "string") {
          reportNum = ev.reportNum;
        } else if (ev.type === "error") {
          onError(ev.msg || "Evaluation failed.");
          return;
        }
      }
    }
  } catch {
    onError("Connection lost during evaluation.");
    return;
  }

  const { score, summary } = parseVerdict(verdictLine || text);
  onDone({
    score,
    summary,
    reportNum,
    reportUrl: reportNum ? `${serverUrl}/pipeline/${reportNum}` : undefined,
  });
}
