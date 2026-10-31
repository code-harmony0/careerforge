#!/usr/bin/env node
// Draft company-specific follow-up emails for overdue applications with agy,
// find a PUBLISHED recipient address for each, and save it to data/contacts.tsv.
//
//   node scripts/agy-followups.mjs --dry-run            list who would be drafted
//   node scripts/agy-followups.mjs --limit 3            draft the 3 most overdue
//   node scripts/agy-followups.mjs --only 27            draft one application
//   node scripts/agy-followups.mjs --refresh            redraft even if a draft exists
//   node scripts/agy-followups.mjs --open 27            open the draft in your mail app (you press Send)
//
// Never sends. Drafts land in output/followups/{num}-{slug}.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/is-main-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "output/followups");
const CONTACTS = path.join(ROOT, "data/contacts.tsv");
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const draftPath = (e) => path.join(OUT_DIR, `${e.num}-${slugify(e.company)}.md`);

/** "Key: value" header lines above a `---` line, then the body. */
export function parseDraft(text) {
  const [head, ...rest] = text.split(/\n---\s*\n/);
  const meta = {};
  for (const line of head.split("\n")) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: rest.join("\n---\n").trim() };
}

const none = (v) => !v || /^none$/i.test(v);

/** Why a draft must be rewritten before it goes anywhere, or null when it is fine. */
export function draftProblems({ meta, body }, company) {
  const problems = [];
  if (!body) problems.push("empty body");
  if (none(meta.subject)) problems.push("no subject");
  if (!body.toLowerCase().includes(company.toLowerCase().split(/\s+/)[0])) problems.push(`never names ${company}`);
  if (none(meta.hook) || none(meta["hook-source"])) problems.push("no company-specific hook with a source, so it is generic");
  else if (/^jd-only/i.test(meta.hook)) problems.push("hook is only the job's own requirement, not a fact about the company");
  if (/just (checking in|following up)|touching base|circling back/i.test(body)) problems.push("uses a banned filler phrase");
  if (body.split(/\s+/).length > 150) problems.push("over 150 words");
  return problems;
}

/** Update-in-place upsert of the recipient into the job-search phonebook. */
function saveContact({ meta, entry, today }) {
  const email = meta.to;
  const name = none(meta["contact-name"]) ? "Hiring team" : meta["contact-name"];
  const notes = `follow-up #${entry.num} draft ${today}; email source: ${meta["to-source"]}; unverified until you confirm it`;
  const row = [name, entry.company, "recruiter", "", "", email, "", String(entry.num), notes].join("\t");
  const lines = fs.existsSync(CONTACTS) ? fs.readFileSync(CONTACTS, "utf8").split("\n") : ["# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker#\tnotes"];
  const cell = (l, i) => (l.split("\t")[i] ?? "").trim().toLowerCase();
  const at = lines.findIndex((l) => l && !l.startsWith("#") && cell(l, 1) === entry.company.toLowerCase() && (cell(l, 5) === email.toLowerCase() || cell(l, 0) === name.toLowerCase()));
  if (at >= 0) {
    const old = lines[at].split("\t");
    // Never blank out a value the user already has; only fill or change email/notes.
    const merged = row.split("\t").map((v, i) => (i === 5 || i === 8 ? v : old[i] || v));
    lines[at] = merged.join("\t");
  } else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(row);
  }
  fs.writeFileSync(CONTACTS, lines.join("\n") + "\n");
}

function buildPrompt(e) {
  const out = path.relative(ROOT, draftPath(e));
  const second = e.followupCount === 1;
  return `Your working directory is ${ROOT}. Draft ONE ${second ? "second" : "first"} follow-up email for my application #${e.num}: ${e.role} at ${e.company}, applied ${e.appliedDate}. DRAFT ONLY: never send, submit, or contact anyone.

INPUTS (read exactly these): modes/followup.md (follow its email rules), ${e.reportPath}, cv.md, config/profile.yml, voice-dna.md if present.
FACTS: use ONLY facts from those files and pages you fetch below. Never invent a metric, name, contact, or claim about me or the company.

1. COMPANY HOOK (required): find ONE specific, true thing about ${e.company} that this email can mention: a product, launch, engineering post, stack choice, or problem stated in the job posting or in the report's company section. Prefer something from the report; if it is thin, use at most 2 web lookups for something recent from the company's own site or blog. Tie it to one real proof point from cv.md, with its number. The hook must be about what the COMPANY builds, ships, or says, not just a requirement the job lists; if all you have is the job's own requirement, write Hook: JD-ONLY followed by that requirement, and still write the email. If you cannot find any verifiable hook, write Hook: NONE; do not fake one.
CLAIMS: never say I use, prefer, or "build with" a tool, workflow, or practice unless cv.md names it. Never add an outcome (for example "without breaking production") that cv.md does not state. Vary the closing ask's wording; do not reuse a stock line.
2. RECIPIENT: use a contact already in the report or data/contacts.tsv if there is one. Otherwise look for an address the company itself PUBLISHED: the job posting's apply/contact address, the careers page, or the official contact page. At most 3 lookups. NEVER guess or construct an address from a name pattern. If none is published, write To: NONE (a LinkedIn note via modes/contacto.md is the fallback).
3. WRITE (${second ? "2-3 sentences, a NEW angle, do not repeat the first follow-up" : "3-4 sentences, lead with the hook and value, then a soft ask with a concrete time window"}), under 120 words, subject "Re: ${e.role}" style with my name, none of "just checking in / following up / touching base / circling back".

Write exactly this to ${out} and nothing else (headers, a line with only ---, then the body):
To: {email or NONE}
To-source: {URL or report/contacts reference, or NONE}
Contact-name: {person's name or Hiring team}
Subject: {subject}
Hook: {the company-specific fact used, or NONE}
Hook-source: {report section or URL, or NONE}
---
{email body}

End with one line: DONE ${out}`;
}

function main() {
  const cad = spawnSync("node", ["followup-cadence.mjs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  const data = JSON.parse(cad.stdout);
  const only = val("--only")?.split(",");
  let rows = data.entries
    .filter((e) => e.reportPath && (only ? only.includes(String(e.num)) : e.urgency === "overdue" && e.status === "applied" && e.followupCount < 2))
    .sort((a, b) => a.daysUntilNext - b.daysUntilNext);
  if (val("--limit")) rows = rows.slice(0, Number(val("--limit")));

  if (val("--open")) {
    const e = data.entries.find((x) => String(x.num) === val("--open"));
    const d = e && fs.existsSync(draftPath(e)) ? parseDraft(fs.readFileSync(draftPath(e), "utf8")) : null;
    if (!d) return console.error("No draft for that number. Draft it first.");
    const to = EMAIL_RE.test(d.meta.to ?? "") ? d.meta.to : "";
    const url = `mailto:${to}?subject=${encodeURIComponent(d.meta.subject ?? "")}&body=${encodeURIComponent(d.body)}`;
    if (!to) console.error("No recipient in this draft; the mail app opens with an empty To: field.");
    spawnSync("open", [url]);
    return console.log("Opened in your mail app. Review it and press Send yourself.");
  }

  if (!rows.length) return console.log("Nothing overdue (interview-stage rows are skipped: use the email/debrief modes for those).");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const summary = [];

  for (const e of rows) {
    const file = draftPath(e);
    if (flag("--dry-run")) { console.log(`would draft #${e.num} ${e.company} - ${e.role} (applied ${e.appliedDate}) -> ${path.relative(ROOT, file)}`); continue; }
    if (fs.existsSync(file) && !flag("--refresh")) { console.log(`skip #${e.num} ${e.company} (draft exists; --refresh to redo)`); continue; }
    console.log(`drafting #${e.num} ${e.company} ...`);
    fs.rmSync(file, { force: true });
    spawnSync("agy", ["-p", buildPrompt(e), "--print-timeout", "300s"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], timeout: 330_000 });
    if (!fs.existsSync(file)) { summary.push([e.num, e.company, "FAILED: agy wrote no draft"]); continue; }
    const d = parseDraft(fs.readFileSync(file, "utf8"));
    const problems = draftProblems(d, e.company);
    const hasEmail = EMAIL_RE.test(d.meta.to ?? "") && !none(d.meta["to-source"]);
    if (hasEmail) saveContact({ meta: d.meta, entry: e, today });
    summary.push([e.num, e.company, problems.length ? `REWRITE: ${problems.join("; ")}` : "ok", hasEmail ? d.meta.to : "no published email found"]);
  }

  if (summary.length) {
    console.log("\n#  company  status  recipient");
    for (const r of summary) console.log(r.join("  |  "));
    console.log("\nDrafts: output/followups/. Open one in your mail app: node scripts/agy-followups.mjs --open <num>");
    console.log("Recipient addresses are unverified: confirm each one before you send, then record it with the followup mode.");
  }
}

if (isMainModule(import.meta.url)) main();
