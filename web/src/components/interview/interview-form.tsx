"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import { PrepDocument } from "@/components/interview/prep-document";
import { slugify } from "@/lib/slugify.mjs";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

type Kind = "interview-prep" | "interview-plan";
type Mode = "pipeline" | "link" | "manual";

const KIND_LABEL: Record<Kind, string> = {
  "interview-prep": "Generate prep brief",
  "interview-plan": "Build prep plan",
};

const MODE_LABEL: Record<Mode, string> = {
  pipeline: "From pipeline",
  link: "Paste a link",
  manual: "Manual",
};

// Minimal shape of /api/pipeline's applications — mirrors career-ops.ts's
// Application type; only the fields this form actually reads.
type Application = {
  n: string;
  company: string;
  role: string;
};

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function InterviewForm({ onOpenSaved }: { onOpenSaved?: (slug: string) => void }) {
  const { jobs, startJob } = useJobs();
  const [mode, setMode] = useState<Mode>("pipeline");

  // Manual-mode fields (unchanged from before).
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [date, setDate] = useState("");

  // Pipeline-mode state.
  const [applications, setApplications] = useState<Application[]>([]);
  // Slugs already on disk in interview-prep/. Not for completeness — it is so
  // the primary button cannot read "Generate prep brief" for a company whose
  // brief is already sitting in the repo, because that button charges for what
  // is effectively a cache hit.
  const [savedSlugs, setSavedSlugs] = useState<Set<string>>(new Set());
  const [pipelineError, setPipelineError] = useState("");
  const [pipelineQuery, setPipelineQuery] = useState("");
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);

  // Paste-a-link mode state.
  const [linkUrl, setLinkUrl] = useState("");
  const [linkHint, setLinkHint] = useState("");
  const [evaluateJobId, setEvaluateJobId] = useState<string | null>(null);
  const [prepJobId, setPrepJobId] = useState<string | null>(null);
  const chainedFor = useRef<Set<string>>(new Set()); // evaluate job ids already chained, so a re-render can't double-fire

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // Snapshot of {company, role} as of the moment the active job was started —
  // save() must use this, not the live company/role state, so editing the
  // fields while a job is running/after it finishes can't silently redirect
  // the save to a different company/role than the one the job actually ran for.
  const [savedFor, setSavedFor] = useState<{ company: string; role: string } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hint, setHint] = useState("");

  const activeJob = jobs.find((j) => j.id === activeJobId);
  const isRunning = activeJob?.status === "running";

  const evaluateJob = jobs.find((j) => j.id === evaluateJobId);
  const prepJob = jobs.find((j) => j.id === prepJobId);

  useEffect(() => {
    fetch("/api/interview")
      .then((res) => res.json())
      .then((d) => setSavedSlugs(new Set((d.briefs ?? []).map((b: { slug: string }) => b.slug))))
      // A failed lookup just means no "already saved" hint, never a blocked form.
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/pipeline")
      .then((res) => res.json())
      .then((data) => setApplications(Array.isArray(data.applications) ? data.applications : []))
      .catch(() => setPipelineError("Couldn't load your pipeline."));
  }, []);

  const filteredApplications = useMemo(() => {
    const q = pipelineQuery.trim().toLowerCase();
    if (!q) return applications;
    return applications.filter((a) => `${a.company} ${a.role}`.toLowerCase().includes(q));
  }, [applications, pipelineQuery]);

  // Mirrors interview-paths.mjs's resolveInterviewPrepPath — same slugify, same
  // {company}-{role} shape — so this asks about the exact file the save route
  // would write, not an approximation of it.
  function savedSlugFor(companyName: string, roleName: string): string | null {
    const c = slugify(companyName ?? "");
    const r = slugify(roleName ?? "");
    if (!c || !r) return null;
    const slug = `${c}-${r}`;
    return savedSlugs.has(slug) ? slug : null;
  }

  function runManual(kind: Kind) {
    if (!company.trim() || !role.trim()) {
      setHint("Company and role are both required.");
      return;
    }
    setHint("");
    setSaveState("idle");
    const input = JSON.stringify({ company, role, jd: jd || undefined, date: kind === "interview-plan" ? date || undefined : undefined });
    const id = startJob({ title: KIND_LABEL[kind], subtitle: `${company} — ${role}`, kind, input, page: "/interview" });
    setActiveJobId(id);
    setSavedFor({ company, role });
  }

  function runFromPipeline(kind: Kind) {
    if (!selectedApp) {
      setHint("Pick an application first.");
      return;
    }
    setHint("");
    setSaveState("idle");
    const id = startJob({
      title: KIND_LABEL[kind],
      subtitle: `${selectedApp.company} — ${selectedApp.role}`,
      kind,
      input: selectedApp.n,
      page: "/interview",
    });
    setActiveJobId(id);
    setSavedFor({ company: selectedApp.company, role: selectedApp.role });
  }

  function runFromLink() {
    const u = linkUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      setLinkHint("Paste a full job-posting URL (https://…).");
      return;
    }
    setLinkHint("");
    setSaveState("idle");
    const id = startJob({ title: "Evaluate · pasted URL", subtitle: u, kind: "evaluate", input: u, page: "/interview" });
    setEvaluateJobId(id);
    setPrepJobId(null);
    setActiveJobId(null);
  }

  // Watch the evaluate job for this mode: once it's done, resolve the report
  // number back to a company/role via /api/pipeline, then auto-chain into
  // interview-prep. Skips the chain entirely on evaluate error (e.g. no CLI
  // configured) — nothing to prep for in that case.
  useEffect(() => {
    if (!evaluateJob || evaluateJob.status === "running") return;
    if (chainedFor.current.has(evaluateJob.id)) return;
    chainedFor.current.add(evaluateJob.id);
    if (evaluateJob.status !== "done" || !evaluateJob.reportNum) return;

    const reportNum = evaluateJob.reportNum;
    fetch("/api/pipeline")
      .then((res) => res.json())
      .then((data) => {
        const apps: Application[] = Array.isArray(data.applications) ? data.applications : [];
        setApplications(apps);
        const app = apps.find((a) => a.n === reportNum);
        const company = app?.company ?? "";
        const role = app?.role ?? "";
        const id = startJob({
          title: KIND_LABEL["interview-prep"],
          subtitle: company && role ? `${company} — ${role}` : `report #${reportNum}`,
          kind: "interview-prep",
          input: reportNum,
          page: "/interview",
        });
        setPrepJobId(id);
        setActiveJobId(id);
        setSavedFor({ company, role });
      })
      .catch(() => {
        setLinkHint("Evaluated, but couldn't resolve the pipeline entry for the prep brief.");
      });
  }, [evaluateJob, startJob]);

  async function save() {
    if (!activeJob || !activeJob.kind || activeJob.status !== "done" || !savedFor?.company || !savedFor?.role) return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/interview/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: savedFor.company, role: savedFor.role, kind: activeJob.kind, content: activeJob.text }),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }

  const history = jobs.filter((j) => j.kind === "interview-prep" || j.kind === "interview-plan").slice(0, 10);

  // ONE result surface for every mode. Link mode used to render its own copy
  // of the output panel keyed off prepJobId while the other modes used
  // activeJobId, which is why a history pick had to force the mode back to
  // "manual" to render anywhere at all. Resolving the job here instead means
  // there is a single answer to "what am I looking at".
  const resultJob = mode === "link" ? prepJob : activeJob;
  const resultKind = resultJob?.kind === "interview-plan" ? "Prep plan" : "Prep brief";

  // A finished run must start at the TOP of the document. The streaming tail
  // scrolls itself as tokens arrive, so without this the completed brief opens
  // wherever the stream happened to leave the viewport — the "it starts at
  // step 5" complaint, which was never a generation bug at all.
  const settled = resultJob && resultJob.status !== "running" ? resultJob.id + resultJob.status : "";
  const lastSettled = useRef("");
  useEffect(() => {
    if (!settled || settled === lastSettled.current) return;
    lastSettled.current = settled;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [settled]);

  return (
    <div className="space-y-6">
      {/* The controls stay a narrow column — a form stretched to the document's
          width is harder to use, not easier. Only the result gets the page. */}
      <div className="co-print-hide max-w-2xl space-y-4">
        <div className="flex flex-wrap gap-1.5 rounded-full border border-border bg-surface/50 p-1 text-sm">
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors",
                mode === m ? "bg-brand text-brand-foreground" : "text-muted hover:bg-surface-hover",
              )}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        {mode === "pipeline" && (
          <div className="space-y-3">
            {pipelineError && <p className="text-xs text-red-400">{pipelineError}</p>}
            <input
              value={pipelineQuery}
              onChange={(e) => setPipelineQuery(e.target.value)}
              placeholder="Search company or role…"
              aria-label="Search pipeline"
              className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
            />
            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              {filteredApplications.length === 0 ? (
                <p className="px-3 py-4 text-xs text-faint">No applications found.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {filteredApplications.map((a) => (
                    <li key={a.n}>
                      <button
                        onClick={() => setSelectedApp(a)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover",
                          selectedApp?.n === a.n && "bg-brand/10",
                        )}
                      >
                        <span className="truncate">
                          <span className="font-medium">{a.company}</span>
                          <span className="text-muted"> — {a.role}</span>
                        </span>
                        <span className="shrink-0 text-xs text-faint">#{a.n}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {selectedApp && (
              <p className="text-xs text-faint">
                Selected: <span className="text-foreground">{selectedApp.company} — {selectedApp.role}</span>
              </p>
            )}
            <AlreadySaved slug={selectedApp ? savedSlugFor(selectedApp.company, selectedApp.role) : null} onOpen={onOpenSaved} />
            {hint && <p className="text-xs text-faint">{hint}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => runFromPipeline(k)}
                  disabled={isRunning || !selectedApp}
                  className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
              <CostBadge kind="spend" size="xs" />
            </div>
          </div>
        )}

        {mode === "link" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-full border border-border bg-surface/70 py-1.5 pl-4 pr-1.5 shadow-sm focus-within:border-brand/50">
              <input
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  if (linkHint) setLinkHint("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runFromLink();
                }}
                placeholder="Paste a job URL…"
                aria-label="Job posting URL"
                className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
              />
              <button
                onClick={runFromLink}
                disabled={evaluateJob?.status === "running" || prepJob?.status === "running"}
                className="shrink-0 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
              >
                Prep for this
              </button>
            </div>
            {linkHint && <p className="text-xs text-faint">{linkHint}</p>}
            <CostBadge kind="spend" size="xs" />

            {/* Two-step chain: evaluate, then prep. The evaluate half is a
                progress line, never a document — its output is a report that
                lives in reports/, not something to read here. */}
            {evaluateJob && (
              <ol className="space-y-1.5 rounded-lg border border-border bg-surface/50 p-3 text-xs">
                <ChainStep n={1} label="Evaluate the posting" status={evaluateJob.status} />
                <ChainStep n={2} label="Write the prep brief" status={prepJob?.status ?? (evaluateJob.status === "done" ? "running" : "pending")} />
                {evaluateJob.status === "error" && (
                  <li className="pt-1 text-red-400">Evaluation failed, so prep didn&apos;t run. Try again, or use Manual mode with the JD pasted in.</li>
                )}
              </ol>
            )}
          </div>
        )}

        {mode === "manual" && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Company"
                aria-label="Company"
                className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
              />
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Role"
                aria-label="Role"
                className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
              />
            </div>
            <textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="Job description (optional, improves prep quality)"
              aria-label="Job description"
              rows={4}
              className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
            />
            <label className="block">
              <span className="mb-1 block text-xs text-faint">Interview date &amp; time — drives the countdown in a prep plan</span>
              <input
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Interview date/time (used by Build prep plan)"
                className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
              />
            </label>
            <AlreadySaved slug={savedSlugFor(company, role)} onOpen={onOpenSaved} />
            {hint && <p className="text-xs text-faint">{hint}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => runManual(k)}
                  disabled={isRunning}
                  className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
              <CostBadge kind="spend" size="xs" />
            </div>
          </div>
        )}
      </div>

      {resultJob && (
        <ResultPanel
          job={resultJob}
          kindLabel={resultKind}
          savedFor={savedFor}
          saveState={saveState}
          onSave={save}
        />
      )}

      {history.length > 0 && (
        <div className="co-print-hide max-w-2xl">
          <p className="text-xs font-medium text-muted">Recent prep</p>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/40">
            {history.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{j.subtitle || j.title}</span>
                <span className="shrink-0 text-xs text-faint">{relativeTime(j.startedAt)}</span>
                <button
                  onClick={() => {
                    setActiveJobId(j.id);
                    setSaveState("idle");
                    setSavedFor(deriveSavedFor(j));
                    // The result surface is shared now, but link mode still
                    // resolves it from prepJobId rather than activeJobId — so a
                    // history pick made while on that tab needs a mode that
                    // reads activeJobId, or it would land on nothing.
                    if (mode === "link") setMode("manual");
                  }}
                  className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:border-brand/50"
                >
                  View
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "You already own this one."
 *
 * Renders nothing when there is no saved brief, so the common case costs
 * nothing. When there IS one it does not disable the generate buttons —
 * regenerating after a JD changes is legitimate — it just makes the free path
 * the visible one, which is the whole difference between an informed second
 * run and an accidental second charge.
 */
function AlreadySaved({ slug, onOpen }: { slug: string | null; onOpen?: (slug: string) => void }) {
  if (!slug) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface/60 px-3 py-2 text-xs text-muted">
      <span>You already have a saved brief for this.</span>
      {onOpen && (
        <button
          onClick={() => onOpen(slug)}
          className="font-medium text-brand-text underline-offset-2 hover:underline"
        >
          Open it, free
        </button>
      )}
      <CostBadge kind="free" size="xs" />
      <span className="text-faint">Generating again costs a run.</span>
    </p>
  );
}

/** One numbered step in link mode's evaluate → prep chain. */
function ChainStep({ n, label, status }: { n: number; label: string; status: "running" | "done" | "error" | "pending" }) {
  const tone =
    status === "done" ? "text-emerald-500" : status === "error" ? "text-red-400" : status === "running" ? "text-brand" : "text-faint";
  const mark = status === "done" ? "✓" : status === "error" ? "✕" : String(n);
  return (
    <li className="flex items-center gap-2">
      <span className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-[9px] font-bold", tone)}>
        {mark}
      </span>
      <span className={status === "pending" ? "text-faint" : "text-muted"}>{label}</span>
      {status === "running" && <Loader2 className="size-3 animate-spin text-brand" />}
    </li>
  );
}

/**
 * The result, in exactly three states.
 *
 * Streaming markdown renders badly — a table half-arrived is a wall of pipes,
 * and a heading mid-token flickers between sizes — so RUNNING shows a plain
 * monospace tail (which is honest about being partial and is the one place an
 * inner scroll box is correct), and only DONE swaps to the real document.
 * ERROR is its own state rather than an empty document, because a failed run
 * that renders as a blank page reads as a broken app.
 *
 * This mirrors the state machine commit 7047b27 landed in the extension for
 * the same problem, rather than inventing a second answer to it.
 */
function ResultPanel({
  job,
  kindLabel,
  savedFor,
  saveState,
  onSave,
}: {
  job: Job;
  kindLabel: string;
  savedFor: { company: string; role: string } | null;
  saveState: "idle" | "saving" | "saved" | "error";
  onSave: () => void;
}) {
  if (job.status === "running") {
    const tail = job.text.split("\n").slice(-40).join("\n");
    return (
      <div className="co-print-hide max-w-2xl rounded-xl border border-border bg-surface/50 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin text-brand" />
          Writing your {kindLabel.toLowerCase()}…
        </p>
        <p className="mt-1 text-xs text-faint">{job.subtitle}</p>
        {job.text ? (
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--pre-bg)] p-3 font-mono text-[11px] leading-relaxed text-faint">
            {tail}
          </pre>
        ) : (
          <p className="mt-3 text-xs text-faint">Reading your CV, profile and story bank…</p>
        )}
      </div>
    );
  }

  if (job.status === "error") {
    // The store records failures as the last status step, not as a field.
    const why = [...job.steps].reverse().find((s) => s.kind === "status")?.label;
    return (
      <div className="co-print-hide max-w-2xl rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-red-400">
          <AlertTriangle className="size-4" />
          That run didn&apos;t finish
        </p>
        {why && <p className="mt-1 text-xs text-muted">{why}</p>}
        {job.text && (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--pre-bg)] p-3 font-mono text-[11px] text-faint">
            {job.text.split("\n").slice(-20).join("\n")}
          </pre>
        )}
      </div>
    );
  }

  if (!job.text.trim()) {
    return (
      <div className="co-print-hide max-w-2xl rounded-xl border border-border bg-surface/50 p-4 text-sm text-faint">
        The run finished but produced no text. Try again, or check your CLI in Config.
      </div>
    );
  }

  return (
    <PrepDocument
      markdown={job.text}
      title={savedFor?.company || job.subtitle || "Prep"}
      subtitle={savedFor?.role}
      kindLabel={kindLabel}
      actions={<SaveBlock job={job} savedFor={savedFor} saveState={saveState} onSave={onSave} />}
    />
  );
}

// Reopening a past job from history needs a {company, role} snapshot for Save
// to keep working. A Job record doesn't carry company/role as its own fields,
// so recover them from whichever source is reliable for that job's mode:
//  - manual-mode jobs pack {company, role} directly into `input` as JSON —
//    parse that first, it's exact.
//  - pipeline/link-mode jobs pack a bare report number into `input` instead,
//    so fall back to the "Company — Role" subtitle text those modes write.
// Returns null when neither source parses (e.g. the "report #042" fallback
// subtitle used when a chained job's pipeline lookup came back empty) — the
// SaveBlock below treats null the same as a blank company/role and shows an
// explicit "can't save this" message instead of silently doing nothing.
function deriveSavedFor(j: Job): { company: string; role: string } | null {
  if (j.input) {
    try {
      const parsed = JSON.parse(j.input);
      if (parsed && typeof parsed.company === "string" && typeof parsed.role === "string") {
        return { company: parsed.company, role: parsed.role };
      }
    } catch {
      /* not JSON — pipeline/link-mode jobs pack a bare report number instead */
    }
  }
  const subtitle = j.subtitle || "";
  const sep = subtitle.indexOf(" — ");
  if (sep === -1) return null;
  return { company: subtitle.slice(0, sep), role: subtitle.slice(sep + 3) };
}

// Shared Save button + status line for a finished job, used by both the
// paste-a-link mode's own "2. Prep brief" panel and the generic results
// panel (pipeline/manual modes, and history reopens). Renders nothing until
// the job is done; once done, shows the Save button only when savedFor has a
// real company AND role — a present-but-blank snapshot (e.g. the chained
// job's pipeline lookup came back empty) gets an explicit explanation instead
// of a button that would just fail after clicking.
function SaveBlock({
  job,
  savedFor,
  saveState,
  onSave,
}: {
  job: Job;
  savedFor: { company: string; role: string } | null;
  saveState: "idle" | "saving" | "saved" | "error";
  onSave: () => void;
}) {
  if (job.status !== "done") return null;
  if (!savedFor?.company || !savedFor?.role) {
    return <p className="mt-2 text-xs text-faint">Couldn&apos;t resolve company/role for this report — save isn&apos;t available.</p>;
  }
  return (
    <>
      <button
        onClick={onSave}
        disabled={saveState === "saving" || saveState === "saved"}
        className="rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-brand/50 disabled:opacity-60"
      >
        {saveState === "saved" ? "Saved to interview-prep/" : saveState === "saving" ? "Saving…" : "Save to interview-prep/"}
      </button>
      {/* Saving is what makes this brief re-openable for free later, so say so
          once — an unsaved run is only ever recoverable by paying again. */}
      <span className="text-xs text-faint">
        {saveState === "saved" ? "Reopen it any time from Saved prep." : "Saved briefs reopen free from Saved prep."}
      </span>
      {saveState === "error" && <span className="text-xs text-red-400">Save failed — try again.</span>}
    </>
  );
}
