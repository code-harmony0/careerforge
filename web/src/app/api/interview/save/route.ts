// web/src/app/api/interview/save/route.ts
//
// The ONLY writer of interview-prep/{company}-{role}.md for web-triggered runs.
// interview-prep and interview-plan both run with no Write/Bash tool
// (see claude-invocation.mjs) — the agent's output is data the client already
// has (job.text after a "done" stream); this route just persists it, the same
// division of labor pdf-render.mjs uses for the PDF envelope (#2185).
import fs from "node:fs";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { resolveInterviewPrepPath, mergeSection, SECTION_HEADINGS } from "@/lib/interview-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { company?: string; role?: string; kind?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { company, role, kind, content } = body;
  if (!kind || !Object.prototype.hasOwnProperty.call(SECTION_HEADINGS, kind)) {
    return Response.json({ error: `kind must be one of: ${Object.keys(SECTION_HEADINGS).join(", ")}` }, { status: 400 });
  }
  if (!content || !content.trim()) {
    return Response.json({ error: "Nothing to save — the run has no output yet." }, { status: 400 });
  }
  const filePath = resolveInterviewPrepPath(careerOpsRoot(), company ?? "", role ?? "");
  if (!filePath) {
    return Response.json({ error: "Company and role are required to save." }, { status: 400 });
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = null;
  }
  const merged = mergeSection(existing, kind as keyof typeof SECTION_HEADINGS, company ?? "", role ?? "", content);
  try {
    atomicWrite(filePath, merged);
  } catch {
    return Response.json({ error: "write failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
