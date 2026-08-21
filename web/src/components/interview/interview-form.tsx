"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export function InterviewForm() {
  const { jobs, startJob } = useJobs();
  const [mode, setMode] = useState<Mode>("pipeline");

  // Manual-mode fields (unchanged from before).
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [date, setDate] = useState("");

  // Pipeline-mode state.
  const [applications, setApplications] = useState<Application[]>([]);
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

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap gap-1.5 rounded-full border border-border bg-surface/50 p-1 text-sm">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-full px-3 py-1.5 font-medium transition-colors ${
              mode === m ? "bg-brand text-brand-foreground" : "text-muted hover:bg-surface-hover"
            }`}
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
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover ${
                        selectedApp?.n === a.n ? "bg-brand/10" : ""
                      }`}
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
          <div className="flex max-w-xl items-center gap-2 rounded-full border border-border bg-surface/70 py-1.5 pl-4 pr-1.5 shadow-sm focus-within:border-brand/50">
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

          {evaluateJob && (
            <div className="rounded-lg border border-border bg-surface/50 p-3">
              <p className="text-xs font-medium text-muted">1. Evaluate</p>
              <p className="mt-1 text-xs text-faint">{evaluateJob.status === "running" ? "Running…" : evaluateJob.status}</p>
              {evaluateJob.status === "error" && (
                <p className="mt-1 text-xs text-red-400">Evaluation failed — prep won&apos;t auto-run. Try again or use Manual mode.</p>
              )}
            </div>
          )}
          {prepJob && (
            <div className="rounded-lg border border-border bg-surface/50 p-3">
              <p className="text-xs font-medium text-muted">2. Prep brief</p>
              <p className="mt-1 text-xs text-faint">{prepJob.status === "running" ? "Running…" : prepJob.status}</p>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{prepJob.text}</pre>
              <SaveBlock job={prepJob} savedFor={savedFor} saveState={saveState} onSave={save} />
            </div>
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
          <input
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Interview date/time (used by Build prep plan)"
            className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
          />
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

      {mode !== "link" && activeJob && (
        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3">
          <p className="text-xs text-faint">{activeJob.status === "running" ? "Running…" : activeJob.status}</p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{activeJob.text}</pre>
          <SaveBlock job={activeJob} savedFor={savedFor} saveState={saveState} onSave={save} />
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-6">
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
                    // The generic results panel below is only shown outside
                    // "link" mode (link mode has its own two-step evaluate/prep
                    // panel keyed off evaluateJobId/prepJobId, not activeJobId) —
                    // switch off it so a history pick always renders somewhere.
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
        className="mt-2 rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-brand/50 disabled:opacity-60"
      >
        {saveState === "saved" ? "Saved to interview-prep/" : saveState === "saving" ? "Saving…" : "Save to interview-prep/"}
      </button>
      {saveState === "error" && <p className="mt-1 text-xs text-red-400">Save failed — try again.</p>}
    </>
  );
}
