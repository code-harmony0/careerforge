"use client";

import { useState } from "react";
import { useJobs } from "@/components/jobs/job-store";

type Kind = "interview-prep" | "interview-plan" | "offer-prep";

const KIND_LABEL: Record<Kind, string> = {
  "interview-prep": "Generate prep brief",
  "interview-plan": "Build prep plan",
  "offer-prep": "Walk through offer",
};

export function InterviewForm() {
  const { jobs, startJob } = useJobs();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [date, setDate] = useState("");
  const [contractText, setContractText] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hint, setHint] = useState("");

  const activeJob = jobs.find((j) => j.id === activeJobId);

  function run(kind: Kind) {
    if (!company.trim() || !role.trim()) {
      setHint("Company and role are both required.");
      return;
    }
    if (kind === "offer-prep" && !contractText.trim()) {
      setHint("Paste the offer/contract text to walk through it.");
      return;
    }
    setHint("");
    setSaveState("idle");
    const input =
      kind === "offer-prep"
        ? JSON.stringify({ company, role, contractText })
        : JSON.stringify({ company, role, jd: jd || undefined, date: kind === "interview-plan" ? date || undefined : undefined });
    const id = startJob({ title: KIND_LABEL[kind], subtitle: `${company} — ${role}`, kind, input, page: "/interview" });
    setActiveJobId(id);
  }

  async function save() {
    if (!activeJob || !activeJob.kind || activeJob.status !== "done") return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/interview/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, role, kind: activeJob.kind, content: activeJob.text }),
      });
      setSaveState(res.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company"
          className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role"
          className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
        />
      </div>
      <textarea
        value={jd}
        onChange={(e) => setJd(e.target.value)}
        placeholder="Job description (optional, improves prep quality)"
        rows={4}
        className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      <input
        type="datetime-local"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      <textarea
        value={contractText}
        onChange={(e) => setContractText(e.target.value)}
        placeholder="Offer/contract text (required only for offer walkthrough)"
        rows={4}
        className="w-full rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm outline-none focus:border-brand/50"
      />
      {hint && <p className="text-xs text-faint">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button
            key={k}
            onClick={() => run(k)}
            className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {activeJob && (
        <div className="mt-4 rounded-lg border border-border bg-surface/50 p-3">
          <p className="text-xs text-faint">{activeJob.status === "running" ? "Running…" : activeJob.status}</p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm">{activeJob.text}</pre>
          {activeJob.status === "done" && (
            <button
              onClick={save}
              disabled={saveState === "saving" || saveState === "saved"}
              className="mt-2 rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-brand/50 disabled:opacity-60"
            >
              {saveState === "saved" ? "Saved to interview-prep/" : saveState === "saving" ? "Saving…" : "Save to interview-prep/"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
