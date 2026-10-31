import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, portalsConfigPath } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import {
  loadPortalsDocument,
  patchPortalFiltersText,
  PortalsConfigError,
  isMapping,
} from "@/lib/portals-config.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObj(v: unknown): v is Record<string, unknown> {
  return isMapping(v);
}

// GET is read-only, for Settings' Location & Region section to show back
// whatever's currently saved (LocationSettings has nowhere else to read it from).
export async function GET() {
  const root = careerOpsRoot();
  const file = portalsConfigPath(root);
  try {
    const { doc } = loadPortalsDocument(
      file,
      path.join(resolveCodeRoot(process.cwd(), process.env), "templates", "portals.example.yml"),
    );
    const lf = isObj(doc.location_filter) ? (doc.location_filter as Record<string, unknown>) : {};
    const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
    return Response.json({
      location: asStrings(lf.allow),
      block: asStrings(lf.block),
      always_allow: asStrings(lf.always_allow),
    });
  } catch {
    return Response.json({ location: [], block: [], always_allow: [] });
  }
}

export async function POST(req: Request) {
  const body = await readJsonObject<{
    roles?: string[];
    location?: string[];
    block?: string[];
    always_allow?: string[];
  }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });

  const roles = (Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter(Boolean).slice(0, 24);
  const clean = (arr?: string[]) => (Array.isArray(arr) ? arr : []).map((v) => String(v).trim()).filter(Boolean);
  const location = Array.isArray(body.location) ? clean(body.location) : undefined;
  const block = Array.isArray(body.block) ? clean(body.block) : undefined;
  const alwaysAllow = Array.isArray(body.always_allow) ? clean(body.always_allow) : undefined;

  if (
    roles.length === 0 &&
    location === undefined &&
    block === undefined &&
    alwaysAllow === undefined
  ) {
    return Response.json({ error: "nothing to save" }, { status: 400 });
  }

  const root = careerOpsRoot();
  const file = portalsConfigPath(root);
  let doc: Record<string, unknown>;
  let source: string;
  try {
    ({ doc, source } = loadPortalsDocument(
      file,
      path.join(resolveCodeRoot(process.cwd(), process.env), "templates", "portals.example.yml"),
    ));
  } catch (error) {
    const invalidUserConfig = error instanceof PortalsConfigError && error.kind === "invalid-user-config";
    return Response.json(
      { error: error instanceof Error ? error.message : "could not load portals.yml" },
      { status: invalidUserConfig ? 409 : 500 },
    );
  }

  if (roles.length > 0) {
    const tf = isObj(doc.title_filter) ? { ...doc.title_filter } : {};
    tf.positive = roles;
    doc.title_filter = tf;
  }
  if (location !== undefined || block !== undefined || alwaysAllow !== undefined) {
    const lf = isObj(doc.location_filter) ? { ...doc.location_filter } : {};
    if (location !== undefined) lf.allow = location;
    if (block !== undefined) lf.block = block;
    if (alwaysAllow !== undefined) lf.always_allow = alwaysAllow;
    doc.location_filter = lf;
  }

  let text: string | null = null;
  if (block === undefined && alwaysAllow === undefined) {
    text = patchPortalFiltersText(source, roles, location);
  }

  if (!text) {
    text = yaml.dump(doc, { lineWidth: 100, noRefs: true });
  }

  try {
    atomicWriteWithBackup(file, text);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return Response.json({ ok: true, roles: roles.length });
}
