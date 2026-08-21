"use client";

import { useState } from "react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

type Kind = "interview-prep" | "interview-plan";

const KIND_LABEL: Record<Kind, string> = {
  "interview-prep": "Generate prep brief",
  "interview-plan": "Build prep plan",
};

export function InterviewForm() {
  const { jobs, startJob } = useJobs();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [date, setDate] = useState("");
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

  function run(kind: Kind) {
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

  async function save() {
    if (!activeJob || !activeJob.kind || activeJob.status !== "done" || !savedFor) return;
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

  return (
    <div className="mt-6 space-y-4">
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
            onClick={() => run(k)}
            disabled={isRunning}
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
          >
            {KIND_LABEL[k]}
          </button>
        ))}
        <CostBadge kind="spend" size="xs" />
      </div>

      {activeJob && (
        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3">
          <p className="text-xs text-faint">{activeJob.status === "running" ? "Running…" : activeJob.status}</p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{activeJob.text}</pre>
          {activeJob.status === "done" && (
            <>
              <button
                onClick={save}
                disabled={saveState === "saving" || saveState === "saved"}
                className="mt-2 rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-brand/50 disabled:opacity-60"
              >
                {saveState === "saved" ? "Saved to interview-prep/" : saveState === "saving" ? "Saving…" : "Save to interview-prep/"}
              </button>
              {saveState === "error" && <p className="mt-1 text-xs text-red-400">Save failed — try again.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
