"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";
import { InterviewForm } from "@/components/interview/interview-form";
import { PrepLibrary } from "@/components/interview/prep-library";
import { QuestionBankView } from "@/components/interview/question-bank-view";

// Two panes, one destination: generate new prep, or reopen prep already on disk.
//
// Kept as a client-side tab rather than two routes on purpose — the form holds
// live job state (a running worker, its streamed output, the unsaved result),
// and a route change would throw that away mid-run.

type Pane = "prepare" | "saved" | "questions";

const PANES: { id: Pane; label: string; hint: string }[] = [
  { id: "prepare", label: "Prepare", hint: "Generate a brief or a time-blocked plan" },
  { id: "saved", label: "Saved prep", hint: "Reopen what's already on disk — free" },
  { id: "questions", label: "Question bank", hint: "Every question you might be asked, and your answers — free" },
];

export function InterviewWorkspace() {
  const [pane, setPane] = useState<Pane>("prepare");
  const [openSlug, setOpenSlug] = useState<string | undefined>();

  // "You already have this one" → switch panes AND open it, rather than making
  // the user find the right card themselves once they get there.
  const openSaved = useCallback((slug: string) => {
    setOpenSlug(slug);
    setPane("saved");
  }, []);

  return (
    <div>
      <div className="co-print-hide">
        <h1 className="text-lg font-semibold">Interview prep</h1>
        <p className="mt-1 max-w-2xl text-sm text-faint">
          Company-specific prep briefs and time-blocked plans, run against your real CV and profile.
        </p>

        <div
          role="tablist"
          aria-label="Interview prep sections"
          className="mt-5 inline-flex gap-1 rounded-full border border-border bg-surface/50 p-1 text-sm"
        >
          {PANES.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={pane === p.id}
              title={p.hint}
              onClick={() => setPane(p.id)}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium transition-colors",
                pane === p.id ? "bg-brand text-brand-foreground" : "text-muted hover:bg-surface-hover",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        {/* Both panes stay MOUNTED — the form owns a running worker and its
            streamed output, and unmounting it to peek at the library would
            drop a run the user is already paying for. */}
        <div className={cn(pane === "prepare" ? "block" : "hidden")}>
          <InterviewForm onOpenSaved={openSaved} />
        </div>
        <div className={cn(pane === "questions" ? "block" : "hidden")}>
          {/* Mounted lazily: the bank fetches on mount, and paying for that
              round-trip on every visit to the Prepare pane is waste. */}
          {pane === "questions" && <QuestionBankView />}
        </div>
        <div className={cn(pane === "saved" ? "block" : "hidden")}>
          <PrepLibrary onPrepare={() => setPane("prepare")} openSlug={openSlug} onOpened={() => setOpenSlug(undefined)} />
        </div>
      </div>
    </div>
  );
}
