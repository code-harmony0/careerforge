"use client";

import { use, useState } from "react";
import Link from "next/link";
import { notFound, useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/components/markdown-components";
import { noMarkdownImages } from "@/lib/markdown-options.mjs";
import { CvDecisionsPanel } from "@/components/jobs/cv-decisions-panel";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, RotateCcw, FileText, CirclePause } from "lucide-react";
import { evaluationGateForJob, isLegacyMissingReportMessage, jobOutputForDisplay } from "@/lib/job-gate.mjs";
import { useJobs } from "@/components/jobs/job-store";
import { missingWorker } from "@/lib/job-route.mjs";
import JobLoading from "./loading";
import { BackLink } from "@/components/back-link";
import { pipelineQuery } from "@/lib/pipeline-navigation.mjs";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { SaveContactForm } from "@/components/save-contact-form";

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs, ready, startJob } = useJobs();
  const router = useRouter();
  const job = jobs.find((j) => j.id === id);
  // Local, not on the job: resolving the question renders a PDF and does not
  // change the run that produced it.
  const [resolved, setResolved] = useState<{ pendingCvAdditions: string[] } | null>(null);
  const query = pipelineQuery(useSearchParams().toString());
  const pipelineHref = `/pipeline${query ? `?${query}` : ""}`;

  if (!ready) return <JobLoading />;
  if (missingWorker({ ready, ids: jobs.map((j) => j.id), id })) notFound();
  if (!job) notFound();

  const gate = evaluationGateForJob(job);
  const displayOutput = jobOutputForDisplay(job);
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <BackLink href={pipelineHref} className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand-text">
        <ArrowLeft className="size-4" /> Pipeline
      </BackLink>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand-text" /> working</>
            ) : gate || job.status === "gated" ? (
              <><CirclePause className="size-3 text-amber-500" /> needs review</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
          </p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
              {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
            </div>
            {job.status !== "running" && job.kind && job.input && (
              <button
                type="button"
                onClick={() => {
                  const newId = startJob({ title: job.title, subtitle: job.subtitle, kind: job.kind!, input: job.input!, page: job.page });
                  if (newId) router.push(`/jobs/${newId}`);
                }}
                title="Run this again to check for anything new — the result above stays as-is until you do"
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]"
              >
                <RotateCcw className="size-3.5" /> Check again
              </button>
            )}
          </div>
          {job.status === "done" && job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
          {job.kind === "evaluate" && job.status === "done" && (job.reportNum || job.reportN) && (
            <Link
              href={`/pipeline/${job.reportNum || job.reportN}`}
              className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200"
            >
              <FileText className="size-4" /> View full report
            </Link>
          )}
        </div>
      </section>

      {gate && (
        <section aria-label="Evaluation needs review" className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <h2 className="font-medium text-foreground">{gate.confirmationRequired ? "Review your conditions before continuing" : "Evaluation stopped by your conditions"}</h2>
          <p className="mt-2 text-sm text-muted">{gate.message}</p>
          <p className="mt-2 text-sm text-muted">
            {gate.legacy ? "The saved output records an evaluation stop. The earlier run's process exit could not be verified; its technical details are kept below." : "No score or evaluation report was created. Your conditions were kept."}
          </p>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("co-assistant"))} className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover">
            Open assistant to review
          </button>
          {gate.legacy && (
            <details className="mt-3 text-sm text-muted">
              <summary className="cursor-pointer font-medium">Earlier run details</summary>
              <p className="mt-2 break-words">{job.steps.at(-1)?.label}</p>
            </details>
          )}
        </section>
      )}

      <ol className="mt-6 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand-text" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
              {gate?.legacy && isLegacyMissingReportMessage(s.label)
                ? "Earlier run returned no report. Review the recorded stop and technical details above."
                : s.kind === "tool" ? `Using ${s.label}` : s.label}
            </span>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand-text" /> thinking…
          </li>
        )}
      </ol>

      {job.pendingDecisions && !resolved && (
        <div className="mt-8">
          <CvDecisionsPanel
            pending={job.pendingDecisions}
            onResolved={(r) => setResolved(r)}
          />
        </div>
      )}

      {resolved && (
        <div className="mt-8 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-sm text-foreground">Tailored CV rendered.</p>
          {resolved.pendingCvAdditions.length > 0 && (
            // Kept on this CV is NOT the same as added to cv.md — the second is
            // a user-layer write that goes through add-entry.mjs's own confirm.
            <p className="mt-1 text-xs text-muted">
              Kept on this CV but still not in your cv.md: {resolved.pendingCvAdditions.join(", ")}
            </p>
          )}
        </div>
      )}

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} {...noMarkdownImages}>{displayOutput}</ReactMarkdown>
          </div>
          {displayOutput !== job.text && (
            <details className="mt-3 text-sm text-muted">
              <summary className="cursor-pointer font-medium">Raw worker output</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-xs">{job.text}</pre>
            </details>
          )}
        </div>
      )}

      {job.kind === "contacto" && job.status === "done" && job.input && (
        <SaveContactForm
          defaultCompany={job.title.split(" · ").slice(1).join(" · ")}
          trackerNum={job.input}
          defaultMessage={job.text.match(/```(?:[a-z]*\n)?([\s\S]*?)```/)?.[1]?.trim() ?? ""}
        />
      )}
    </div>
  );
}
