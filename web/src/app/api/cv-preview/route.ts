import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { NextRequest } from "next/server";
import { resolveCli } from "@/lib/clis";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { parseCvPayloadEnvelope, PAYLOAD_ENVELOPE_INSTRUCTION } from "@/lib/cv-payload-envelope.mjs";
import { previewDir, previewPath, thumbPath, isSafeTemplateName, cvHash, writeManifest } from "@/lib/cv-previews.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // one agent pass + one Chromium render per template

// GET — serve a cached preview artifact: the PNG the grid shows, or the PDF
// the full-size link opens.
export async function GET(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("template") ?? "").trim();
  if (!isSafeTemplateName(name)) return new Response("bad template", { status: 400 });
  // The grid asks for the thumbnail; the full-size link asks for the PDF.
  const wantsThumb = req.nextUrl.searchParams.get("format") === "png";
  const root = careerOpsRoot();
  let buf: Buffer;
  try {
    buf = fs.readFileSync(wantsThumb ? thumbPath(root, name) : previewPath(root, name));
  } catch {
    return new Response("no preview yet for this template", { status: 404 });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": wantsThumb ? "image/png" : "application/pdf",
      "Content-Disposition": `inline; filename="cv-preview-${name}.${wantsThumb ? "png" : "pdf"}"`,
      // A preview is regenerated in place at the same URL, so a cached copy
      // would show the previous CV after a regenerate with no way to bust it.
      "Cache-Control": "no-store",
    },
  });
}

function run(file: string, args: string[], cwd: string, timeout: number): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ ok: !error, err: error ? String(stderr || error.message).slice(0, 400) : "" });
    });
  });
}

function templatePath(root: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [rootScript("cv-templates"), "resolve", "cv", name],
      { cwd: root, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

function listTemplateNames(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(process.execPath, [rootScript("cv-templates"), "list", "cv"], { cwd: root, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed.map((t) => t?.name).filter(isSafeTemplateName) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

// One generation at a time. Two concurrent runs would interleave writes to the
// same payload.json and the same seven PDFs, and the loser's manifest would
// claim the winner's renders were built from a CV they were not.
let generating = false;

export async function POST(req: Request) {
  let body: { cliId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const resolved = body.cliId ? resolveCli(body.cliId) : null;
  if (!resolved) return Response.json({ error: "cliId required" }, { status: 400 });

  const root = careerOpsRoot();
  let cv: string;
  try {
    cv = fs.readFileSync(path.join(root, "cv.md"), "utf8");
  } catch {
    return Response.json({ error: "Add your CV first — there is nothing to preview." }, { status: 400 });
  }
  const needed = ["build-cv-html", "generate-pdf", "cv-thumb"];
  if (needed.some((s) => !fs.existsSync(rootScript(s)))) {
    return Response.json(
      { error: "This needs a complete career-ops checkout (build-cv-html.mjs, generate-pdf.mjs, cv-thumb.mjs)." },
      { status: 400 },
    );
  }
  const names = await listTemplateNames(root);
  if (!names.length) return Response.json({ error: "no CV templates found in templates/" }, { status: 500 });

  if (generating) return Response.json({ error: "previews are already being generated" }, { status: 409 });
  generating = true;
  try {
    // One agent pass for the whole gallery. It reads cv.md and returns the
    // template-agnostic payload; it is NOT tailoring to any job, so no report,
    // no company, and nothing that would make this a user-facing CV.
    const prompt = [
      "You are preparing a preview of the user's OWN CV, headless, on their machine.",
      "Read cv.md and config/profile.yml, then convert the CV into build-cv-html.mjs's JSON payload — a faithful structural transcription, NOT a rewrite.",
      "Keys: lang, page_format ('letter' or 'a4'), candidate {name, email, phone, location, linkedin {url,display}, github {url,display}, portfolio {url,display}}, summary (string), competencies (string[]), experience [{company, role, period, location, bullets: string[]}], projects [{name, stack, bullets: string[]}], education [{institution, degree, period}], certifications [], awards [], skills [{category, items: string[]}].",
      "Copy the user's real content verbatim wherever possible. Never invent a skill, employer, date, metric or qualification, and never drop one — a preview that shows content the CV does not contain is worse than no preview.",
      "Omit any key the CV has no content for rather than inventing a placeholder.",
      PAYLOAD_ENVELOPE_INSTRUCTION,
      "",
      "After the envelope, end with EXACTLY one final line: VERDICT: {5 if the payload was emitted, else 1}/5 — {≤12 words}",
    ].join("\n");

    const { spec, binPath } = resolved;
    const isClaude = body.cliId === "claude";
    const args = isClaude ? claudeCliArgs({ kind: "cv-preview", prompt }) : spec.args(prompt);
    const child = spawnHeadlessCli(binPath, args, { cwd: root, env: process.env });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const stdout: string = await new Promise((resolve) => {
      let out = "";
      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, 420_000);
      child.stdout.on("data", (c: string) => {
        out += c;
      });
      child.on("close", () => {
        clearTimeout(killer);
        resolve(out);
      });
    });

    // A CLI's stream-json output wraps the agent's text in JSON events, so the
    // envelope markers arrive escaped. Unescaping the whole stream is enough to
    // put them back on their own lines for the parser, and is safe because the
    // parser is fail-closed about everything it then finds.
    const flat = stdout.includes(`\\n`) ? stdout.replace(/\\n/g, "\n").replace(/\\"/g, '"') : stdout;
    const env = parseCvPayloadEnvelope(flat.includes("<<cv-payload>>") ? flat : stdout);
    if (!env.ok) return Response.json({ error: env.error }, { status: 502 });

    const dir = previewDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const payloadFile = path.join(dir, "payload.json");
    fs.writeFileSync(payloadFile, JSON.stringify(env.payload, null, 2), "utf8");

    const failed: string[] = [];
    for (const name of names) {
      const tpl = await templatePath(root, name);
      if (!tpl) {
        failed.push(name);
        continue;
      }
      const html = path.join(dir, `${name}.html`);
      const built = await run(process.execPath, [rootScript("build-cv-html"), payloadFile, html, tpl], root, 60_000);
      if (!built.ok) {
        failed.push(name);
        continue;
      }
      // --allow-reorder: a template is free to order its sections differently
      // from the base one; that is what makes it a different template, and the
      // section-order guard exists for tailored CVs, not for a layout preview.
      const rendered = await run(
        process.execPath,
        [rootScript("generate-pdf"), html, previewPath(root, name), "--allow-reorder"],
        root,
        180_000,
      );
      if (!rendered.ok) {
        failed.push(name);
        continue;
      }
      // The grid shows this, so a template whose thumbnail failed has nothing to
      // display and counts as failed even though its PDF rendered fine.
      const thumbed = await run(process.execPath, [rootScript("cv-thumb"), html, thumbPath(root, name)], root, 120_000);
      if (!thumbed.ok) failed.push(name);
    }

    if (failed.length === names.length) {
      writeManifest(root, { cvHash: cvHash(cv), failed });
      return Response.json({ error: "every template failed to render — check that Playwright is installed." }, { status: 500 });
    }
    writeManifest(root, { cvHash: cvHash(cv), failed });
    return Response.json({ ok: true, rendered: names.length - failed.length, failed });
  } finally {
    generating = false;
  }
}
