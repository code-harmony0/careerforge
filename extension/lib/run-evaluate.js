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
  } catch {
    onText("\n\n[connection lost during evaluation]");
    return;
  }

  const { score, summary } = parseVerdict(verdictLine || text);
  const scoreLine = score != null ? `Score: ${score}/5${summary ? ` — ${summary}` : ""}` : "Done (no score line found).";
  const linkLine = reportNum ? `\n${serverUrl}/pipeline/${reportNum}` : "";
  onText(`${scoreLine}${linkLine}`);
}
