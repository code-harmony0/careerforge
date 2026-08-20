// web/src/app/api/interview/save/route.ts
//
// The ONLY writer of interview-prep/{company}-{role}.md for web-triggered runs.
// interview-prep, interview-plan, and offer-prep all run with no Write/Bash tool
// (see claude-invocation.mjs) — the agent's output is data the client already
// has (job.text after a "done" stream); this route just persists it, the same
// division of labor pdf-render.mjs uses for the PDF envelope (#2185).
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
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
  if (!kind || !(kind in SECTION_HEADINGS)) {
    return Response.json({ error: `kind must be one of: ${Object.keys(SECTION_HEADINGS).join(", ")}` }, { status: 400 });
  }
  if (!content || !content.trim()) {
    return Response.json({ error: "Nothing to save — the run has no output yet." }, { status: 400 });
  }
  const filePath = resolveInterviewPrepPath(careerOpsRoot(), company ?? "", role ?? "");
  if (!filePath) {
    return Response.json({ error: "Company and role are required to save." }, { status: 400 });
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = null;
  }
  const merged = mergeSection(existing, kind as keyof typeof SECTION_HEADINGS, company ?? "", role ?? "", content);
  fs.writeFileSync(filePath, merged, "utf8");

  return Response.json({ ok: true, path: filePath });
}
