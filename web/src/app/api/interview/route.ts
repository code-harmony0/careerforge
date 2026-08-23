// web/src/app/api/interview/route.ts
//
// Reads back what /api/interview/save wrote. Until this existed, a saved brief
// was write-only: interview-prep/{slug}.md accumulated on disk and the only way
// to see one again was to pay for a fresh LLM run of work already on the disk.
//
// Read-only by construction — no POST, no fs writes, and every path is built
// from a slug matched against SLUG_RE rather than joined from user input.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { parseSavedBrief, documentTeaser } from "@/lib/interview-doc.mjs";
import { SECTION_HEADINGS } from "@/lib/interview-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only shape resolveInterviewPrepPath (via slugify) can ever produce. A
// request slug that doesn't match is rejected outright rather than sanitized:
// a rewritten slug would silently serve a DIFFERENT company's brief, which is
// worse than a 400.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// interview-prep/ also holds the cross-company substance files and the session
// transcripts directory. They are not per-company briefs and must not show up
// as library cards.
const KNOWN_SECTIONS = new Set<string>(Object.values(SECTION_HEADINGS));

const NOT_A_BRIEF = new Set(["story-bank.md", "question-bank.md", "README.md"]);

/** Fallback display name when a hand-edited file has lost its title line. */
function titleCaseSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(req: Request) {
  const dir = path.join(careerOpsRoot(), "interview-prep");
  const slug = new URL(req.url).searchParams.get("slug");

  if (slug !== null) {
    if (!SLUG_RE.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, `${slug}.md`), "utf8");
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const doc = parseSavedBrief(content);
    return Response.json({
      slug,
      company: doc.company || titleCaseSlug(slug),
      role: doc.role,
      sections: doc.sections,
      content,
    });
  }

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No interview-prep/ directory yet is the normal first-run state, not an
    // error — the library renders its empty state from an empty list.
    return Response.json({ briefs: [] });
  }

  const briefs = names
    .filter((n) => n.endsWith(".md") && !NOT_A_BRIEF.has(n))
    .map((name) => {
      const filePath = path.join(dir, name);
      let content = "";
      let updatedAt = 0;
      try {
        content = fs.readFileSync(filePath, "utf8");
        updatedAt = fs.statSync(filePath).mtimeMs;
      } catch {
        // A file that vanished between readdir and read (or an unreadable one)
        // is skipped below rather than failing the whole listing.
        return null;
      }
      const fileSlug = name.slice(0, -3);
      const doc = parseSavedBrief(content);
      return {
        slug: fileSlug,
        company: doc.company || titleCaseSlug(fileSlug),
        role: doc.role,
        updatedAt,
        // Which kinds are already on file — this is what lets the form offer
        // "Open brief" instead of silently charging for a regeneration.
        //
        // Only the headings mergeSection actually writes count. The BODY of a
        // saved brief is LLM output that carries its own "## Step 2 — Process
        // Overview" headings, and treating those as kinds turned one card into
        // a wall of thirteen meaningless chips.
        kinds: doc.sections.map((s) => s.heading).filter((h) => KNOWN_SECTIONS.has(h)),
        teaser: documentTeaser(doc.sections[0]?.body ?? content),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return Response.json({ briefs });
}
