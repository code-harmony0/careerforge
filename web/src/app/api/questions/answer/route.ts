// web/src/app/api/questions/answer/route.ts
//
// Your own answer to one question, and the free analysis of it.
//
// The analysis costs nothing — no model is called anywhere in this file. That
// is the point: length in SPOKEN seconds, filler and hedge counts, whether the
// answer leads with a result, which of your real CV terms you used, and which
// numeric claims are NOT backed by cv.md. For most answers that is the whole
// of the useful feedback, and paying a model for it would be paying for
// arithmetic.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { analyseAnswer } from "@/lib/answer-analysis.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only id shape question-bank.mjs mints. Anything else is rejected rather
// than sanitized: a rewritten id would silently read or overwrite a DIFFERENT
// question's answer, which is worse than a 400.
const ID_RE = /^q\d{1,6}$/i;
// An interview answer is a few paragraphs. A cap keeps a runaway paste from
// filling the user's disk through an endpoint that takes no other input.
const MAX_ANSWER_BYTES = 64 * 1024;

function answerPath(id: string) {
  return path.join(careerOpsRoot(), "interview-prep", "answers", `${id.toLowerCase()}.md`);
}

function readCv(): string {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), "cv.md"), "utf8");
  } catch {
    // No CV means no grounding check and no term matching, but the length,
    // filler and structure feedback all still work. Degrade, do not fail.
    return "";
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID_RE.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  let answer = "";
  try {
    answer = fs.readFileSync(answerPath(id), "utf8");
  } catch {
    return Response.json({ id, answer: "", analysis: null, exists: false });
  }
  const question = new URL(req.url).searchParams.get("question") ?? "";
  return Response.json({ id, answer, analysis: analyseAnswer({ answer, cv: readCv(), question }), exists: true });
}

export async function PUT(req: Request) {
  let body: { id?: string; answer?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { id = "", answer = "", question = "" } = body;
  if (!ID_RE.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  if (Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES) {
    return Response.json({ error: "answer too long" }, { status: 413 });
  }

  const file = answerPath(id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // An empty answer DELETES rather than writing a blank file, so clearing the
    // box does not leave a zero-byte artifact that reads as "answered".
    if (!answer.trim()) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return Response.json({ id, answer: "", analysis: null, exists: false });
    }
    atomicWrite(file, answer);
  } catch {
    return Response.json({ error: "write failed" }, { status: 500 });
  }
  return Response.json({ id, answer, analysis: analyseAnswer({ answer, cv: readCv(), question }), exists: true });
}
