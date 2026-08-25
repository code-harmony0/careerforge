import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { cvHash, previewState, readManifest } from "@/lib/cv-previews.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CV template gallery's data source. Discovery is delegated to the core's
// cv-templates.mjs rather than reimplemented here: it already owns the filename
// pattern, the `career-ops-template` meta block, and the required-marker
// validation, and a second copy of those rules in the web app would drift the
// first time a template gains a field.
type Template = { name: string; displayName: string };

function listTemplates(root: string): Promise<Template[]> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [rootScript("cv-templates"), "list", "cv"],
      { cwd: root, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.name === "string") : []);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function profilePath(root: string) {
  return path.join(root, "config", "profile.yml");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readProfile(root: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(fs.readFileSync(profilePath(root), "utf8"));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCv(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "cv.md"), "utf8");
  } catch {
    return null;
  }
}

export async function GET() {
  const root = careerOpsRoot();
  const templates = await listTemplates(root);
  const profile = readProfile(root);
  const cv = readCv(root);
  // An unset cv.template means the base templates/cv-template.html, which
  // cv-templates.mjs names "standard" — the gallery must show that as the
  // current selection rather than nothing selected.
  const cvCfg = isObj(profile.cv) ? profile.cv : {};
  const selected = typeof cvCfg.template === "string" ? cvCfg.template : "standard";

  const hash = cv === null ? null : cvHash(cv);
  const manifest = readManifest(root);

  return Response.json({
    hasCv: cv !== null,
    selected,
    generatedAt: manifest.generatedAt,
    templates: templates.map((t) => ({
      ...t,
      state: previewState(root, t.name, hash, manifest),
    })),
  });
}

export async function POST(req: Request) {
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  const root = careerOpsRoot();
  // Validate against what actually exists on disk rather than a shape check.
  // The value is written into config/profile.yml and later resolved to a file
  // path by cv-templates.mjs, so an unknown name would persist a config that
  // fails at render time, far from where it was set.
  const templates = await listTemplates(root);
  if (!templates.some((t) => t.name === name)) {
    return Response.json({ error: `unknown template: ${name}` }, { status: 400 });
  }

  const file = profilePath(root);
  // DATA_CONTRACT: config/profile.yml is user-layer. A malformed file is never
  // overwritten — that would destroy archetypes and targeting the user wrote by
  // hand — and only the cv.template key is touched.
  let profile: Record<string, unknown>;
  if (!fs.existsSync(file)) {
    return Response.json({ error: "config/profile.yml does not exist yet — set up your profile first." }, { status: 409 });
  }
  try {
    const parsed = yaml.load(fs.readFileSync(file, "utf8"));
    profile = isObj(parsed) ? parsed : {};
  } catch {
    return Response.json(
      { error: "config/profile.yml exists but is not valid YAML — refusing to overwrite it." },
      { status: 409 },
    );
  }

  const cvCfg = isObj(profile.cv) ? { ...profile.cv } : {};
  cvCfg.template = name;
  const merged = { ...profile, cv: cvCfg };

  try {
    // yaml.dump reformats and drops comments, so the .bak is the safety net —
    // same reasoning as the profile writer this mirrors.
    atomicWriteWithBackup(file, yaml.dump(merged, { lineWidth: 100, noRefs: true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return Response.json({ ok: true, selected: name });
}
