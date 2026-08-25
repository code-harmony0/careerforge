import fs from "node:fs";
import { spawn } from "node:child_process";
import { careerOpsRoot, findReportFile } from "@/lib/career-ops";
import { resolvePdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf } from "@/lib/pdf-render.mjs";
import { applyCvDecisions } from "@/lib/cv-decisions.mjs";
import { PAGE_FORMATS, DEFAULT_PAGE_FORMAT } from "@/lib/page-formats.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // a Chromium render, no agent

// Resumes a pdf run that stopped to ask.
//
// /api/run's pdf branch saves the CV, then stops WITHOUT rendering when the
// generated CV asserts competencies cv.md does not support (modes/pdf.md step
// 14a's headless equivalent — a spawnHeadlessCli agent has no channel to be
// asked on). The saved HTML is still on disk; this applies the user's per-item
// decisions to it and renders.
//
// No agent runs here. Dropping a tag is a deterministic edit to HTML the
// backend already holds, so resuming costs no tokens and cannot come back with
// a different CV than the one the user just made decisions about.
export async function POST(req: Request) {
  let body: { reportNum?: string; format?: string; decisions?: Array<{ tag?: string; action?: string }> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const reportNum = typeof body.reportNum === "string" ? body.reportNum.trim() : "";
  if (!/^\d{1,4}$/.test(reportNum)) return Response.json({ error: "reportNum required" }, { status: 400 });
  // Normalized at the trust boundary: this arrives from a browser page and a
  // browser extension, and applyCvDecisions treats any non-"add" action as a
  // drop, so a half-formed entry must be discarded here rather than silently
  // becoming a drop decision the user never made.
  const decisions = (Array.isArray(body.decisions) ? body.decisions : [])
    .filter((d): d is { tag: string; action: string } => typeof d?.tag === "string" && typeof d?.action === "string");
  if (!decisions.length) return Response.json({ error: "decisions required" }, { status: 400 });

  const root = careerOpsRoot();
  const today = new Date().toISOString().slice(0, 10);
  // Recomputed rather than accepted from the client: these are filesystem
  // paths, and the backend owning naming is the same rule /api/run follows.
  const paths = resolvePdfPaths(reportNum, today, root, findReportFile);
  if (!paths.ok) return Response.json({ error: paths.error }, { status: 400 });

  let html: string;
  try {
    html = fs.readFileSync(paths.paths.html, "utf8");
  } catch {
    return Response.json(
      { error: "That tailored CV is no longer on disk — re-run the tailoring step." },
      { status: 409 },
    );
  }

  const { html: decided, toAdd } = applyCvDecisions(html, decisions);
  try {
    fs.writeFileSync(paths.paths.html, decided, "utf8");
  } catch {
    return Response.json({ error: "could not save the reviewed CV" }, { status: 500 });
  }

  const requested = typeof body.format === "string" ? body.format : "";
  const format = (PAGE_FORMATS.has(requested) ? requested : DEFAULT_PAGE_FORMAT) as "letter" | "a4";
  const result = await renderAndMarkPdf({
    spawnFn: spawn,
    execPath: process.execPath,
    root,
    pdfPaths: paths.paths,
    format,
    reportNum,
  });
  if (result.kind === "render-failed") {
    return Response.json({ error: result.error.slice(0, 300) }, { status: 500 });
  }

  // `toAdd` is REPORTED, never written. Adding to cv.md is a user-layer write
  // that modes/pdf.md routes through add-entry.mjs's confirm-before-write and
  // dedup; doing it silently here would put a claim in the user's canonical CV
  // as a side effect of clicking "keep on this CV", which are different
  // decisions with different consequences.
  return Response.json({ ok: true, warnings: result.warnings ?? [], pendingCvAdditions: toAdd });
}
