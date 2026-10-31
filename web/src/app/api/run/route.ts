// Both spawners are needed here, and the distinction matters: the agent CLI goes
// through spawnHeadlessCli (which closes stdin so `codex exec` can't hang waiting
// on it, #2085), while the PDF render is a plain Node child process with no CLI
// sandbox in the way (#2172) and so passes `spawn` itself to renderAndMarkPdf.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback } from "@/lib/clis";
import { localISODate } from "@/lib/followups";
import { accumulateTokens, createAgentTextJoiner, isFatalGenericStderr, killMsForKind, timeoutMessage } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findReportFile, findApplicationByReportNum, readInbox, readScanDates, readLanguageConfig } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { createReportEnvelopeFilter } from "@/lib/report-envelope.mjs";
import { persistEvaluation, evaluateRunOutcome } from "@/lib/report-persist.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { loadCompetencyChecker } from "@/lib/cv-review.mjs";
import { parseCoverRequest } from "@/lib/cover-brief.mjs";
import { capabilitiesFor } from "@/lib/worker-capabilities.mjs";
import { fencingReport, isCliAllowedForCapabilities } from "@/lib/cli-fencing.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { resolveCvTemplate } from "@/lib/core/cv-template.mjs";
import { profileRef } from "@/lib/core/profile-path.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { createRunFinalizer } from "@/lib/run-finalizer.mjs";
import { readJsonObject } from "@/lib/json-body";
import { parseEvaluationOptions, selectedEvaluationInstructions } from "@/lib/evaluation-options.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

export async function POST(req: Request) {
  const body = await readJsonObject<{
    kind?: string;
    input?: string;
    cliId?: string;
    brief?: unknown;
    evaluationSections?: unknown;
    jdText?: string;
  }>(req);
  if (!body) return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  const { kind = "evaluate", input, cliId: requestedCliId, brief, jdText } = body;
  const evaluation = kind === "evaluate" ? parseEvaluationOptions(body.evaluationSections) : undefined;
  if (evaluation && !evaluation.ok) return Response.json({ error: evaluation.error }, { status: 400 });
  if (!input || !requestedCliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCliOrFallback(requestedCliId);
  if (!resolved) {
    return new Response(JSON.stringify(cliUnavailableError(requestedCliId)), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;
  // The CLI actually running: fencing, capabilities and argv below are keyed on it.
  const cliId = spec.id;
  const substitution = cliSubstitutionNotice(resolved);
  const capabilities = capabilitiesFor(kind);
  if (!isCliAllowedForCapabilities(cliId, capabilities)) {
    return new Response(
      JSON.stringify({ error: `CLI '${cliId}' cannot run write-capable worker '${kind}' without a verified permission adapter.` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // The precondition must check the file the prompt will actually read.
  const lang = readLanguageConfig();
  const needsScript: Record<string, string> = {
    evaluate: lang.evalModeFile,
    "fix-portal": "verify-portals.mjs",
    pdf: "generate-pdf.mjs",
    cover: "modes/cover.md",
    "interview-prep": "modes/interview-prep.md",
    "interview-plan": "modes/interview/plan.md",
  };
  const required = needsScript[kind];
  // Scripts and system modes live in the code checkout, which on a split-layout
  // install is not the data root (cv.md, reports/ and output stay under that).
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  // CAREER_OPS_ROOT is runtime user data, not a build input. Tracing this
  // dynamic path would copy the whole web project into every server bundle.
  const requiredPath = required
    ? path.join(/* turbopackIgnore: true */ codeRoot, required)
    : "";
  if (required && !fs.existsSync(/* turbopackIgnore: true */ requiredPath)) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). The career-ops code checkout is incomplete — point CAREER_OPS_CODE_ROOT at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Assemble selected canonical instructions before any extraction or model call.
  // Omitted work never becomes part of the worker's evaluation instructions.
  let evaluationInstructions: string | null = null;
  if (evaluation?.ok && !evaluation.full) {
    try {
      // modes/ and batch/ are system files: they live in the code checkout.
      const root = codeRoot;
      evaluationInstructions = selectedEvaluationInstructions({
        mode: fs.readFileSync(/* turbopackIgnore: true */ requiredPath, "utf8"),
        canonicalMode: fs.readFileSync(/* turbopackIgnore: true */ path.join(root, "modes/oferta.md"), "utf8"),
        shared: fs.readFileSync(/* turbopackIgnore: true */ path.join(root, "modes/_shared.md"), "utf8"),
        batch: fs.readFileSync(/* turbopackIgnore: true */ path.join(root, "batch/batch-prompt.md"), "utf8"),
        sections: evaluation.sections,
      });
    } catch (error) {
      console.error("[career-ops] Failed to load focused evaluation instructions:", error);
      return Response.json({ error: "Could not load the selected evaluation instructions. No AI run was started." }, { status: 422 });
    }
  }

  // fix-portal's prompt puts this straight into a shell command the agent runs, and
  // a company name can arrive from a public ATS listing rather than the user's own
  // typing. Refuse rather than sanitize: a silently rewritten name would repair the
  // wrong portal.
  if (kind === "fix-portal" && !isShellSafeCompanyName(input)) {
    return new Response(
      JSON.stringify({ error: "That company name has characters I can't safely pass to the portal checker — rename it in portals.yml first." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if (
    (kind === "evaluate" || kind === "pdf" || kind === "cover" || kind === "interview-prep" || kind === "interview-plan") &&
    !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))
  ) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = localISODate();

  // Awaited here, before the stream opens: the call site is a sync child "close"
  // handler (see the decisions gate below) and must not become async.
  const competencyChecker = kind === "pdf" ? await loadCompetencyChecker(careerOpsRoot()) : null;

  // Precompute deterministic scratch + final paths so the agent never chooses
  // its own filenames — the backend owns naming, writing (#2185) and rendering
  // (#2172). Nothing is cleared first: writeCvHtml rewrites the HTML
  // from this run's freshly parsed envelope before any render, and the agent is
  // no longer told these paths, so a stale file cannot survive into a render.
  let pdfPaths: PdfPaths | undefined;
  if (kind === "pdf") {
    const pathsResult = resolvePdfPaths(input, today, careerOpsRoot(), findReportFile);
    if (!pathsResult.ok) {
      return new Response(JSON.stringify({ error: pathsResult.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    pdfPaths = pathsResult.paths;
  }

  const coverRequest = kind === "cover" ? parseCoverRequest({ input, brief, root: careerOpsRoot(), findReportFile }) : undefined;
  if (coverRequest && !coverRequest.ok) {
    return new Response(JSON.stringify({ error: coverRequest.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → report-persist writes no segment at all.
  const postedAt =
    kind === "evaluate"
      ? readInbox().find((j) => j.url === input)?.postedAt ?? readScanDates().get(input)
      : undefined;

  // Which CV template the worker fills. Resolved HERE, for the same reason `lang`
  // is: the worker has no Bash (#2172), so it cannot run cv-templates.mjs and the
  // prompt used to name the base template outright, silently ignoring cv.template
  // (#4034). Only pdf fills a template, so nothing else pays for the lookup.
  const cvTemplate = kind === "pdf" ? await resolveCvTemplate(codeRoot) : undefined;

  const prompt = buildPrompt({
    kind,
    input,
    memory: readMemory(),
    today,
    postedAt,
    lang,
    cvTemplate,
    // The worker's cwd is the data root; modes, templates and scripts live in the checkout.
    codeRoot,
    reportFile: pdfPaths?.reportFile ?? (coverRequest?.ok ? coverRequest.reportFile : undefined),
    coverBrief: coverRequest?.ok ? coverRequest.brief : undefined,
    profile: profileRef(careerOpsRoot()),
    evaluationInstructions,
    // Only evaluate consumes it; capped so a huge page can't blow the argv limit.
    jdText: kind === "evaluate" && typeof jdText === "string" ? jdText.slice(0, 20_000) : undefined,
    root: careerOpsRoot(),
  });

  const isClaude = cliId === "claude";
  // Which tools each kind gets, and the whole claude argv, live in
  // claude-invocation.mjs — see its header for the policy and for why it is asserted on
  // built values rather than on this file's source. NEVER auto-submits; that
  // remains a prompt-level guarantee.
  const args = isClaude ? claudeCliArgs({ kind, prompt }) : (spec.streamArgs ?? spec.args)(prompt);

  // Tracker-mutating runs hold a write token so a row delete can't race their
  // merge (tracker.mjs delete doesn't yet share a lock with merge-tracker,
  // see run-registry). evaluate's agent no longer writes; the backend persist
  // path below still merges the tracker, so the token stays.
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;

  let child;
  try {
    child = spawnHeadlessCli(
      binPath,
      args,
      { cwd: careerOpsRoot(), env: process.env },
      { cliId, capabilities },
    );
  } catch (e) {
    if (writeToken !== null) releaseTrackerWrite(writeToken);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "failed to start the CLI" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const enc = new TextEncoder();

  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pdfRenderPromise: Promise<void> | null = null;
  let evaluatePersistPromise: Promise<void> | null = null;

  const finishRun = createRunFinalizer(child, () => {
    if (writeToken !== null) releaseTrackerWrite(writeToken);
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false;
      let sawError = false;
      let stderrBuf = "";
      const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
      let stderrErrorSnippet: string | null = null;
      const flagStderrLine = (line: string) => {
        if (stderrErrorSnippet || !line.trim() || !isFatalStderr(line)) return;
        stderrErrorSnippet = line.trim().slice(0, 200);
      };
      let lastTokens = 0;
      let lastCostUsd: number | null = null;
      const killMs = killMsForKind(kind);
      let killedByTimeout = false;

      killer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, killMs);

      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
        }
      };

      const fencing = fencingReport({ cliId, cliName: spec.name, capabilities: capabilitiesFor(kind) });
      if (fencing.notice) send({ type: "status", label: fencing.notice });
      if (substitution) send({ type: "status", label: substitution });

      heartbeat = setInterval(() => send({ type: "keepalive" }), 10_000);
      const close = () => {
        finishRun();
        if (!closed) {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (killer) clearTimeout(killer);
          try { controller.close(); } catch { /* */ }
        }
      };

      const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
      const reportFilter = kind === "evaluate" ? createReportEnvelopeFilter() : null;

      const sendAgentText = (text: string) => {
        const filter = cvFilter ?? reportFilter;
        const visible = filter ? filter.push(text) : text;
        if (visible) send({ type: "text", text: visible });
      };

      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };

      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
        if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
        return written.ok;
      };

      const joinAgentText = createAgentTextJoiner();
      const processParsedLine = (line: string) => {
        if (!spec.parseEvent) return;
        const ev = spec.parseEvent(line);
        const text = joinAgentText(ev);
        if (text) {
          emittedText = true;
          sendAgentText(text);
        }
        if (ev?.tool) send({ type: "tool", name: ev.tool });
        if (ev?.status) send({ type: "status", label: ev.status });
        lastTokens = accumulateTokens(lastTokens, ev);
        if (typeof ev?.costUsd === "number") lastCostUsd = ev.costUsd;
        if (ev?.error) {
          sawError = true;
          send({ type: "error", msg: ev.error.slice(0, 200) });
        }
      };

      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        if (!spec.parseEvent) {
          emittedText = true;
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) processParsedLine(line);
        }
      });

      const logStderr = (chunk: string) => {
        try {
          const dir = path.join(careerOpsRoot(), ".career-ops-web");
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, "run-stderr.log"), `[${new Date().toISOString()}] ${kind}/${input} ${cliId}: ${chunk}`);
        } catch {
          /* diagnostics must never take down the run they are diagnosing */
        }
      };

      child.stderr.on("data", (chunk: string) => {
        logStderr(chunk);
        stderrBuf += chunk;
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          flagStderrLine(line);
        }
      });

      const persistEval = async (markdown: string) => {
        send({ type: "status", label: "Saving report…" });
        try {
          const result = await persistEvaluation({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            coreRoot: resolveCodeRoot(process.cwd(), process.env),
            markdown,
            url: input,
            today,
            postedAt,
            evaluationSections: evaluation?.ok ? evaluation.sections : undefined,
          });
          if (!result.ok) {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          sendWarnings(result.warnings);
          const reportN = Number(result.num);
          if (Number.isFinite(reportN)) {
            const appN = findApplicationByReportNum(String(reportN))?.n;
            send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd, reportN, reportNum: String(reportN), appN });
          } else {
            send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
          }
        } catch (e) {
          send({ type: "error", msg: `Evaluation persist crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        send({ type: "status", label: "Rendering PDF…" });
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            coreRoot: resolveCodeRoot(process.cwd(), process.env),
            pdfPaths: paths,
            format,
            reportNum: paths.reportNum,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          sendWarnings(result.warnings);
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        if (closed) return close();
        if (killedByTimeout) {
          send({
            type: "error",
            msg: timeoutMessage(killMs, kind),
          });
          return close();
        }
        const trailing = buf.trim();
        if (trailing) {
          buf = "";
          processParsedLine(trailing);
        }
        const cleanExit = code === 0;
        const noOutputError = (): string | null => {
          if (!emittedText && !sawError && !cleanExit) {
            const detail = stderrErrorSnippet ? ` (${stderrErrorSnippet})` : "";
            return `The CLI exited with an error — is it installed and authenticated?${detail}`;
          }
          if (!emittedText && !sawError) return "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)";
          return null;
        };

        if (kind === "pdf") {
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (!pdfPaths || envelope?.ok !== true) {
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save — please report this." });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              const pending = competencyChecker ? competencyChecker(envelope.html) : [];
              if (pending.length) {
                send({
                  type: "decisions",
                  reportNum: input,
                  format: envelope.format,
                  items: pending,
                });
                send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd, awaitingDecisions: true });
                return close();
              }
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
              return;
            }
          }
          return close();
        }

        if (kind === "evaluate") {
          const tail = reportFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          const envelope = reportFilter?.result();
          const outcome = evaluateRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (envelope?.ok !== true) {
            send({ type: "error", msg: "Internal error: the evaluate run passed its gate with no report to save — please report this." });
          } else {
            evaluatePersistPromise = persistEval(envelope.markdown);
            return;
          }
          return close();
        }

        const baseErr = noOutputError();
        if (baseErr) {
          send({ type: "error", msg: baseErr });
        } else if (!cleanExit || sawError) {
          const detail = !sawError && stderrErrorSnippet ? ` (${stderrErrorSnippet})` : "";
          send({ type: "error", msg: `This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify.${detail}`.slice(0, 200) });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (killer) clearTimeout(killer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      const followup = pdfRenderPromise ?? evaluatePersistPromise;
      if (followup) {
        followup.finally(finishRun);
      } else {
        finishRun();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
