import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, pipelineSummary, withCloseDates } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh local files

function getReportUrls(root: string): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const reportsDir = path.join(root, "reports");
    const files = fs.readdirSync(reportsDir);
    for (const f of files) {
      if (!f.endsWith(".md") || f.includes("-RESERVED.md")) continue;
      const num = parseInt(f, 10);
      if (Number.isNaN(num)) continue;
      try {
        const content = fs.readFileSync(path.join(reportsDir, f), "utf8");
        const m = content.match(/\*\*URL:\*\*[ \t]*(\S+)/);
        if (m) {
          map.set(num, m[1].replace(/[),.;]+$/, "").replace(/^<|>$/g, ""));
        }
      } catch {}
    }
  } catch {}
  return map;
}

// Exposes the user's pipeline (inbox + tracker) to the client so the assistant
// can resolve "all the Anthropic ones" to concrete postings CLIENT-SIDE — the
// model only ever emits a company name, never URLs (no hallucination, no tokens).
export async function GET() {
  const s = pipelineSummary();
  const root = s.root || careerOpsRoot();
  const reportUrls = getReportUrls(root);

  const mappedApplications = s.applications.map((app) => {
    if (app.url) return app;
    const n = parseInt(app.n, 10);
    const repMatch = app.report?.match(/\b(\d+)\b/);
    const reportN = repMatch ? parseInt(repMatch[1], 10) : n;
    const url = (Number.isFinite(reportN) ? reportUrls.get(reportN) : null) || (Number.isFinite(n) ? reportUrls.get(n) : null) || "";
    return url ? { ...app, url } : app;
  });

  const applications = await withCloseDates(mappedApplications);
  return Response.json({
    inbox: s.inbox,
    applications,
    root: s.root,
    rootExists: s.rootExists,
  });
}
