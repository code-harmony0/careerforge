// web/src/app/api/questions/route.ts
//
// Read the question bank; delegate every write to the root CLI.
//
// GET parses interview-prep/question-bank.md directly — it is a read, there is
// nothing to race. PATCH shells out to `node question-bank.mjs status`, which
// holds the bank's lock across the read-modify-write. Writing the file from
// here instead would reintroduce exactly the bug #2900 fixed for the tracker:
// atomicWrite is atomic about the FILE, not about the read-modify-write around
// it, so a concurrent CLI write would be silently overwritten by a copy of the
// bank that predated it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { parseQuestionBank, facets } from "@/lib/question-bank-read.mjs";

// The parser is header-driven, so a row is whatever columns the file declared.
// Typed as an open record rather than a fixed shape for exactly that reason:
// pinning the fields here would reintroduce the positional coupling the
// header-driven design exists to avoid.
type Row = Record<string, string | number>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["new", "🔴", "🟡", "✅"]);
const ID_RE = /^q\d{1,6}$/i;
// Bounded below the browser's patience so a contended bank comes back as
// "retry shortly" rather than a hung request.
const WRITE_TIMEOUT_MS = 15_000;

function bankPath() {
  return path.join(careerOpsRoot(), "interview-prep", "question-bank.md");
}

export async function GET(req: Request) {
  let raw = "";
  try {
    raw = fs.readFileSync(bankPath(), "utf8");
  } catch {
    // No bank yet is the normal first-run state, not an error. The UI renders
    // its empty state and tells you the seed command.
    return Response.json({ questions: [], facets: { axis: [], tag: [], status: [], round: [] }, total: 0, exists: false });
  }
  const { questions, skipped } = parseQuestionBank(raw) as { questions: Row[]; skipped: number[] };
  const url = new URL(req.url);
  const pick = (k: string) => url.searchParams.get(k)?.trim().toLowerCase() || "";

  let rows = questions;
  for (const key of ["axis", "tag", "status", "round"]) {
    const want = pick(key);
    if (want) rows = rows.filter((r) => String(r[key] ?? "").toLowerCase() === want);
  }
  const q = pick("q");
  if (q) rows = rows.filter((r) => String(r.question ?? "").toLowerCase().includes(q));

  return Response.json({
    questions: rows,
    // Facets come from the UNFILTERED set: a chip that vanishes the moment you
    // click a sibling chip cannot be used to widen a search again.
    facets: facets(questions),
    total: questions.length,
    shown: rows.length,
    skipped,
    exists: true,
  });
}

export async function PATCH(req: Request) {
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { id, status } = body;
  // Validate BEFORE spawning: both values reach a child process argv, so a
  // rejected shape here is one that never becomes an argument.
  if (!id || !ID_RE.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  if (!status || !STATUSES.has(status)) return Response.json({ error: "bad status" }, { status: 400 });

  const root = careerOpsRoot();
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, "question-bank.mjs"), "status", id, status],
      { cwd: root, timeout: WRITE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

  if (result.code === 4) {
    return Response.json({ error: "The question bank is busy — try again in a moment." }, { status: 503 });
  }
  if (result.code !== 0) {
    return Response.json({ error: result.stderr.trim() || "write failed" }, { status: 500 });
  }
  try {
    return Response.json(JSON.parse(result.stdout));
  } catch {
    return Response.json({ ok: true });
  }
}
