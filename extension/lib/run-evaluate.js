// extension/lib/run-evaluate.js
import { fmtElapsed } from "./run-job.js";
// Drives the same /api/run contract web/src/components/jobs/job-store.tsx's
// startJob() uses — but reports STRUCTURED progress/result callbacks instead
// of a growing wall of raw text, so the side panel can render a real status
// line + result card instead of a chat bubble nobody can read the state of.
import { parseVerdict } from "./verdict.js";

// callbacks:
//   onStatus(label)              — a short human-readable progress line
//   onDone({score, summary, reportNum, reportUrl})
//   onError(message)
//   onAborted()                  — signal was aborted (user hit Stop); not an error
//
// `signal` is forwarded to fetch AND checked against the reader loop's own
// catch, because aborting can surface as the fetch() call throwing (not
// started yet) or as reader.read() throwing (mid-stream) depending on
// timing — both need to route to onAborted, not onError, or Stop would
// render as a failure. Aborting the fetch also tears down the server's
// ReadableStream, whose cancel() (web/src/app/api/run/route.ts) kills the
// underlying CLI child process — so Stop actually stops the work, not just
// the UI.
export async function runEvaluate({ serverUrl, cliId, url, signal, onStatus, onDone, onError, onAborted }) {
  let res;
  try {
    res = await fetch(`${serverUrl}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "evaluate", input: url, cliId }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      onAborted?.();
      return;
    }
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
  const startedAt = Date.now();
  let phase = "Working…";
  let buf = "";
  let text = "";
  let verdictLine = "";
  let reportNum; // the REPORT FILE number (reports/{n}-...md) — for pdf/cover job `input`
  let appN; // the TRACKER ROW number — separate, diverging counter (see career-ops.ts's
  // findApplicationByReportNum) — for anything that navigates/writes by application #
  // (StatusSelect, /api/status, /pipeline/{n})
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
          // Same defect as run-job.js: liveness must not depend on OPTIONAL
          // events. A CLI with no structured event stream (6 of the 8 supported)
          // can go minutes between text chunks while the model thinks, and an
          // unchanging label reads as a hang.
          onStatus(`${phase} · ${fmtElapsed(Date.now() - startedAt)}`);
        } else if (ev.type === "text") {
          const full = text + ev.text;
          const vm = full.match(/VERDICT:[^\n]*/i);
          if (vm) verdictLine = vm[0];
          text = full.slice(-4000);
          phase = "Writing the report…";
          onStatus(phase);
        } else if (ev.type === "done" && typeof ev.reportNum === "string") {
          reportNum = ev.reportNum;
          if (typeof ev.appN === "string") appN = ev.appN;
        } else if (ev.type === "error") {
          onError(ev.msg || "Evaluation failed.");
          return;
        }
      }
    }
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) {
      onAborted?.();
      return;
    }
    onError("Connection lost during evaluation.");
    return;
  }

  const { score, summary } = parseVerdict(verdictLine || text);
  // /pipeline/{n} navigation wants the application (row) number, not the
  // report file number — they usually coincide but are separate counters
  // that can diverge (see career-ops.ts's findApplicationByReportNum). Fall
  // back to reportNum only if appN genuinely never arrived (e.g. a non-Claude
  // CLI run whose tracker-merge step the server couldn't confirm) — better a
  // possibly-wrong link than none, and /pipeline/{n} degrades to a 404 rather
  // than a silent write failure the way /api/status would.
  const navN = appN || reportNum;
  onDone({
    score,
    summary,
    reportNum,
    appN: navN,
    reportUrl: navN ? `${serverUrl}/pipeline/${navN}` : undefined,
  });
}
