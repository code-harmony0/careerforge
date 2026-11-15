import { findApplication, findApplicationByReportNum, readReport } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const param = url.searchParams.get("n") || url.searchParams.get("id");
  if (!param || !/^\d+$/.test(param)) {
    return Response.json({ error: "missing or invalid n parameter" }, { status: 400 });
  }

  const app = findApplicationByReportNum(param) || findApplication(param);
  const repNumMatch = typeof app?.report === "string" ? app.report.match(/\[(\d+)\]/) : null;
  const effectiveNum = repNumMatch ? repNumMatch[1] : param;
  const report = readReport(effectiveNum) || readReport(param);

  if (!app && !report) {
    return Response.json({ error: "report not found" }, { status: 404 });
  }

  return Response.json({
    app,
    report: report ? { file: report.file, content: report.content } : null,
    content: report?.content || null,
  });
}
