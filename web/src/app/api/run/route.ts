// Both spawners are needed here, and the distinction matters: the agent CLI goes
// through spawnHeadlessCli (which closes stdin so `codex exec` can't hang waiting
// on it, #2085), while the PDF render is a plain Node child process with no CLI
// sandbox in the way (#2172) and so passes `spawn` itself to renderAndMarkPdf.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback } from "@/lib/clis";
import { localISODate } from "@/lib/followups";
import { accumulateTokens, createAgentTextJoiner, isFatalGenericStderr, killMsForKind, noOutputError, timeoutMessage } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findReportFile, findApplicationByReportNum, readInbox, readScanDates, readLanguageConfig } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { dataFolderMissingMessage, unsafeDataRootMessage } from "@/lib/core/data-root.mjs";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { materializeTailoredCv, withSharedPdfPath } from "@/lib/cv-from-json.mjs";
import { saveBuiltCv } from "@/lib/pdf-run-save.mjs";
import { createCvEnvelopeFilter } from "@/lib/cv-envelope.mjs";
import { createReportEnvelopeFilter } from "@/lib/report-envelope.mjs";
import { persistEvaluation, evaluateRunOutcome, evaluationOutcomeEvent } from "@/lib/report-persist.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { loadCompetencyChecker } from "@/lib/cv-review.mjs";
import { isTruncatedJd, prefetchJd } from "@/lib/jd-prefetch.mjs";
import { runCoreCli } from "@/lib/core-cli";
import { parseCoverRequest } from "@/lib/cover-brief.mjs";
import { capabilitiesFor } from "@/lib/worker-capabilities.mjs";
import { fencingReport, isCliAllowedForCapabilities } from "@/lib/cli-fencing.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { resolveCvTemplate, resolveUserTemplatesDir } from "@/lib/core/cv-template.mjs";
import { getProfilePath, profileRef } from "@/lib/core/profile-path.mjs";
import { readPageFormatSetting, resolveRenderPageFormat, type PageFormatSetting } from "@/lib/core/page-format.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { createRunFinalizer } from "@/lib/run-finalizer.mjs";
import { readJsonObject } from "@/lib/json-body";
import { writeEvaluationInstructions } from "@/lib/evaluation-instructions-file.mjs";
import { spillOversizedPrompt } from "@/lib/oversized-prompt.mjs";
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
    ats?: unknown;
  }>(req);
  if (!body) return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  const { kind = "evaluate", input, cliId: requestedCliId, brief, jdText, ats } = body;
  const evaluation = kind === "evaluate" ? parseEvaluationOptions(body.evaluationSections) : undefined;
  if (evaluation && !evaluation.ok) return Response.json({ error: evaluation.error }, { status: 400 });
  if (!input || !requestedCliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  let userData: string;
  try {
    userData = careerOpsRoot();
  } catch (err) {
    const unsafe = unsafeDataRootMessage(err);
    if (!unsafe) throw err;
    return new Response(JSON.stringify({ error: unsafe }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!fs.existsSync(userData)) {
    return new Response(JSON.stringify({ error: dataFolderMissingMessage(userData) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
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
  // The root is passed, not re-derived: a relative CAREER_OPS_PROFILE resolves
  // against it, and `process.cwd()` here is `<core>/web` (see cv-template.mjs).
  // The data root goes in too: a template from the core's user layer (#5777) lives
  // there, so it is named relative to the worker's cwd, not the checkout.
  const dataRoot = kind === "pdf" ? careerOpsRoot() : undefined;

  const cvTemplate = dataRoot
    ? await resolveCvTemplate(codeRoot, dataRoot)
    : undefined;

  const userTemplatesDir = dataRoot
    ? await resolveUserTemplatesDir(codeRoot, dataRoot)
    : undefined;
  // The profile's page_format, read once HERE: the prompt names the marker
  // before the run, and the render below reuses this stance instead of reading
  // the profile again.
  // The web used to let the agent pick, which overrode a4/letter and never
  // reached auto.
  const pageFormat: PageFormatSetting | undefined = dataRoot
    ? await readPageFormatSetting(codeRoot, getProfilePath(dataRoot))
    : undefined;
  // Hold the tracker guard through evaluation persistence / PDF marking. Build
  // the prompt inside the same try so preparation failures release it too. It is
  // taken before the JD prefetch, so a row delete cannot land in that window.
  const writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;
  let child;
  let instructionFile: ReturnType<typeof writeEvaluationInstructions> | undefined;
  let spill: ReturnType<typeof spillOversizedPrompt> | undefined;
  try {
    // Read the JD here, not in the worker: WebFetch drops script content, so a
    // board that renders its JD from script data looks like an empty shell to the
    // worker and the run ends as "Needs review" on a live posting. null (plain
    // boards, any miss) leaves the worker on its WebFetch path.
    const prefetch = kind === "evaluate" ? await prefetchJd(input, runCoreCli, req.signal) : null;
    // The caller went away while the JD was being read: do not start a worker for nobody.
    if (req.signal.aborted) {
      if (writeToken !== null) releaseTrackerWrite(writeToken);
      return new Response(null, { status: 499 });
    }
    // A partial JD must not reach a worker that could score and save it as the
    // whole posting, so refuse here instead of trusting the prompt to stop it.
    if (isTruncatedJd(prefetch?.text)) {
      if (writeToken !== null) releaseTrackerWrite(writeToken);
      return Response.json({ error: "This posting is longer than the platform can read in full, so it was not scored. Evaluate it from your agent CLI with the job text pasted in (for example /career-ops, then paste the posting). No AI run was started." }, { status: 422 });
    }
    const prefetchedJd = prefetch?.text ?? null;
    const closedEvidence = prefetch?.closedEvidence ?? null;
    if (evaluationInstructions) {
      instructionFile = writeEvaluationInstructions(careerOpsRoot(), evaluationInstructions);
    }
    const prompt = buildPrompt({
      kind,
      input,
      memory: readMemory(),
      today,
      postedAt,
      lang,
      cvTemplate,
      userTemplatesDir,
      pageFormat,
      // The worker's cwd is the data root; modes, templates and scripts live in the checkout.
      codeRoot,
      reportFile: pdfPaths?.reportFile ?? (coverRequest?.ok ? coverRequest.reportFile : undefined),
      coverBrief: coverRequest?.ok ? coverRequest.brief : undefined,
      profile: profileRef(careerOpsRoot()),
      evaluationInstructions: instructionFile?.reference,
      prefetchedJd,
      closedEvidence,
      jdText: kind === "evaluate" && typeof jdText === "string" ? jdText.slice(0, 20_000) : undefined,
      root: careerOpsRoot(),
    });

    const isClaude = cliId === "claude";
    // Which tools each kind gets, and the whole claude argv, live in
    // claude-invocation.mjs — see its header for the policy and for why it is asserted on
    // built values rather than on this file's source. NEVER auto-submits; that
    // remains a prompt-level guarantee.
    // Non-Claude CLIs get no tool flags from spec.args(), so permission for them is
    // applied at the spawn boundary instead: spawnHeadlessCli takes what this kind
    // needs (capabilitiesFor) and cli-fencing.mjs translates it for the chosen
    // runtime — an OS sandbox on Codex, nothing yet on the runtimes with no
    // verified mechanism. Those report level "none" and the run says so
    // below, rather than looking identical to a fenced one (#2507).
    // A CLI with its own structured stream gets the argv that turns it on, so its
    // stdout matches spec.parseEvent below; spec.args stays the plain-text argv the
    // envelope-parsing routes rely on.
    const buildArgs = (p: string) =>
      isClaude ? claudeCliArgs({ kind, prompt: p }) : (spec.streamArgs ?? spec.args)(p);
    // The prompt inlines the whole _profile.md (#4003), so it can outgrow the OS
    // command-line limit (ENAMETOOLONG on Windows). Every kind that reaches here
    // can Read (see TOOL_SCOPES), so an oversized prompt goes to a file under the
    // data root and argv carries a pointer to it. Prompts that fit are untouched.
    spill = spillOversizedPrompt({
      prompt,
      buildArgs,
      binPath,
      fencing: { cliId, capabilities },
      root: careerOpsRoot(),
    });
    child = spawnHeadlessCli(
      binPath,
      spill.args,
      { cwd: careerOpsRoot(), env: process.env },
      { cliId, capabilities },
    );
    if (instructionFile) child.once("close", instructionFile.cleanup);
    if (spill.cleanup) child.once("close", spill.cleanup);
  } catch (e) {
    instructionFile?.cleanup();
    spill?.cleanup?.();
    // Fencing refuses an argv that contradicts the capability record, so nothing
    // spawned and the stream below — which owns finishRun — is never
    // constructed. Release the tracker guard HERE or it is held for the lifetime
    // of the process and acquireTrackerWrite blocks every later evaluate/pdf run:
    // a refused argv would take the tracker down with it.
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
<<<<<<< HEAD

=======
      // Assistant-authored text only, before report-body filtering. Tools/JDs
      // cannot directly declare a gated outcome. Process integrity is checked
      // first at close, before this text can be treated as a terminal stop.
      let evaluationText = "";
      // While the agent emits the 15-25 KB <<cv-html>> envelope, cvFilter swallows
      // every byte, so the response stream goes completely silent for as long as
      // the model takes to write the CV — a minute or more. Nothing downstream can
      // tell that from a hung request, and the browser/proxy drops the connection;
      // the client then reports "Connection error" even though the agent is fine
      // and the PDF renders correctly server-side. Emit a throttled keepalive so
      // the stream never idles during the filtered phase. Unknown event types are
      // ignored by the client's switch, so this is safe for older tabs too.
>>>>>>> upstream/main
      const sendAgentText = (text: string) => {
        if (kind === "evaluate") evaluationText += text;
        const filter = cvFilter ?? reportFilter;
        const visible = filter ? filter.push(text) : text;
        if (visible) send({ type: "text", text: visible });
      };

      const sendWarnings = (warnings: string[]) => {
        for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
      };
<<<<<<< HEAD

      const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
        const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
=======
      /** Persist the emitted CV; streams the reason and returns false on failure. */
      const saveCv = (paths: PdfPaths, cv: { html: string }) => {
        const written = writeCvHtml({ pdfPaths: paths, html: cv.html });
>>>>>>> upstream/main
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
            send({ type: "error", msg: result.error.slice(0, 1500) });
            return;
          }
          sendWarnings(result.warnings);
          const reportN = Number(result.num);
          const scoreNum = result.score ? parseFloat(result.score) : null;
          const score = typeof scoreNum === "number" && !Number.isNaN(scoreNum) ? scoreNum : null;
          const summary = result.summary || "";
          if (Number.isFinite(reportN)) {
            const appN = findApplicationByReportNum(String(reportN))?.n;
            send({
              type: "done",
              tokens: lastTokens,
              costUsd: lastCostUsd,
              reportN,
              reportNum: String(reportN),
              appN,
              score,
              summary,
              company: result.company,
              role: result.role,
            });
          } else {
            send({
              type: "done",
              tokens: lastTokens,
              costUsd: lastCostUsd,
              score,
              summary,
              company: result.company,
              role: result.role,
            });
          }
        } catch (e) {
          send({ type: "error", msg: `Evaluation persist crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };
<<<<<<< HEAD

      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
=======
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4", ats?: { html: string; finalPdf: string } | null) => {
>>>>>>> upstream/main
        send({ type: "status", label: "Rendering PDF…" });
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            coreRoot: resolveCodeRoot(process.cwd(), process.env),
            dataRoot: careerOpsRoot(),
            pdfPaths: paths,
            format,
            reportNum: paths.reportNum,
            ats,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 1500) });
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
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputMessage = (): string | null =>
          noOutputError({ emittedText, sawError, cleanExit, stderrSnippet: stderrErrorSnippet });

        if (kind === "pdf") {
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputMessage(),
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
            // Tracked so cancel() can defer releasing writeToken until this
            // settles. close() happens once rendering finishes, not here.
            pdfRenderPromise = withSharedPdfPath(pdfPaths.html, async () => {
              let scratchDir = "";
              try {
                // The profile outranks the agent's pick, and auto maps the
                // country it named, both through the core (core/page-format.mjs).
                // The builder copies this sheet onto the JSON payload so the
                // HTML width and the PDF page are the same size.
                const sheet = await resolveRenderPageFormat(codeRoot, {
                  setting: pageFormat?.setting ?? null,
                  declared: envelope.format,
                  country: envelope.country,
                });
                sendWarnings(sheet.warnings);
                await saveBuiltCv({
                  build: async () => {
                    const built = await materializeTailoredCv({
                      envelope: { ...envelope, format: sheet.format },
                      coreRoot: resolveCodeRoot(process.cwd(), process.env),
                      dataRoot: careerOpsRoot(),
                      cvTemplate,
                      userTemplatesDir,
                      reportFile: pdfPaths.reportFile,
                      htmlPath: pdfPaths.html,
                      finalPdf: pdfPaths.finalPdf,
                      ats: body.ats === true,
                    });
                    if (built.ok && built.scratchDir) scratchDir = built.scratchDir;
                    return built;
                  },
                  isClosed: () => closed,
                  onError: (error) => send({ type: "error", msg: error.slice(0, 200) }),
                  onWarnings: sendWarnings,
                  save: (built) => {
                    if (!saveCv(pdfPaths, { html: built.html })) return false;
                    const pending = competencyChecker ? competencyChecker(built.html) : [];
                    if (pending.length) {
                      send({
                        type: "decisions",
                        reportNum: input,
                        format: sheet.format,
                        items: pending,
                      });
                      send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd, awaitingDecisions: true });
                      return false;
                    }
                    return true;
                  },
                  render: (built) => renderPdf(pdfPaths, sheet.format, built.ats),
                });
              } catch (e) {
                send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
              } finally {
                // force:true only skips a missing dir. EPERM and EBUSY still throw,
                // and a throw here used to skip close(), which holds the stream
                // and the tracker-write guard after the PDF is already done.
                try {
                  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
                } catch {
                  // The run already reported its outcome. A leftover scratch dir is the smaller failure.
                } finally {
                  close();
                }
              }
            });
            return;
          }
          return close();
        }

        if (kind === "evaluate") {
          const tail = reportFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          const envelope = reportFilter?.result();
          const outcome = evaluateRunOutcome({
            envelope,
            noOutputMessage: noOutputMessage(),
            sawError,
            cleanExit,
            text: evaluationText,
            agentText: reportFilter?.rawText?.(),
          });
          if (!outcome.ok) {
            const event = evaluationOutcomeEvent(outcome, { tokens: lastTokens, costUsd: lastCostUsd });
            if (event) send(event);
          } else if (envelope?.ok !== true) {
            send({ type: "error", msg: "Internal error: the evaluate run passed its gate with no report to save — please report this." });
          } else {
            evaluatePersistPromise = persistEval(envelope.markdown);
            return;
          }
          return close();
        }

        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit
        // and real output. Anything else is surfaced. An errored run must never be
        // banked as a confident score.
        const baseErr = noOutputMessage();
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
