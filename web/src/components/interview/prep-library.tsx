"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookOpen, RefreshCw } from "lucide-react";
import { PrepDocument } from "@/components/interview/prep-document";
import { CostBadge } from "@/components/cost/cost-badge";

// Everything already saved to interview-prep/, readable for free.
//
// Before this existed the save route was write-only: briefs accumulated on disk
// and the only way to see one again was to pay for a fresh LLM run of work
// already sitting in the repo. That is the most expensive bug this page had —
// not a slow path, a path that silently charges for a cache hit.

type Brief = {
  slug: string;
  company: string;
  role: string;
  updatedAt: number;
  kinds: string[];
  teaser: string;
};

type Opened = { slug: string; company: string; role: string; content: string };

function relativeTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function PrepLibrary({
  onPrepare,
  openSlug,
  onOpened,
}: {
  onPrepare?: () => void;
  /** Slug the Prepare pane asked to open — set when the user clicks
   *  "Open the saved one" instead of paying for a regeneration. */
  openSlug?: string;
  /** Cleared once that request has been honoured, so picking the same company
   *  again later opens it again instead of being swallowed as a no-op. */
  onOpened?: () => void;
}) {
  const [briefs, setBriefs] = useState<Brief[] | null>(null);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [opening, setOpening] = useState("");

  const load = useCallback(() => {
    setError("");
    fetch("/api/interview")
      .then((r) => r.json())
      .then((d) => setBriefs(Array.isArray(d.briefs) ? d.briefs : []))
      .catch(() => {
        setBriefs([]);
        setError("Couldn't read interview-prep/.");
      });
  }, []);

  useEffect(load, [load]);

  const open = useCallback(async (slug: string) => {
    setOpening(slug);
    setError("");
    try {
      const res = await fetch(`/api/interview?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      setOpened({ slug, company: d.company ?? slug, role: d.role ?? "", content: d.content ?? "" });
      window.scrollTo({ top: 0 });
    } catch {
      setError("Couldn't open that brief — the file may have been moved or deleted.");
    } finally {
      setOpening("");
    }
  }, []);

  useEffect(() => {
    if (!openSlug) return;
    open(openSlug).finally(() => onOpened?.());
  }, [openSlug, open, onOpened]);

  if (opened) {
    return (
      <div>
        <button
          onClick={() => setOpened(null)}
          className="co-print-hide mb-2 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> All saved prep
        </button>
        <PrepDocument
          markdown={opened.content}
          title={opened.company}
          subtitle={opened.role}
          kindLabel="Saved"
          actions={
            <span className="text-xs text-faint">
              Read from <code className="text-[11px]">interview-prep/{opened.slug}.md</code> — free, no run.
            </span>
          }
        />
      </div>
    );
  }

  if (briefs === null) {
    return <p className="py-8 text-sm text-faint">Loading saved prep…</p>;
  }

  if (briefs.length === 0) {
    // An empty state that teaches the loop, not a shrug. The library only fills
    // up as a side effect of saving a run, and nothing else on the page says so.
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <BookOpen className="mx-auto size-6 text-faint" />
        <p className="mt-3 text-sm font-medium">Nothing saved yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-faint">
          Generate a prep brief, then hit <span className="text-muted">Save to interview-prep/</span>. It lands here and
          reopening it after that is free — no second run, no second charge.
        </p>
        {onPrepare && (
          <button
            onClick={onPrepare}
            className="mt-4 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
          >
            Prepare for an interview
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-faint">
          {briefs.length} saved · reopening runs nothing <CostBadge kind="free" size="xs" className="ml-1 align-middle" />
        </p>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {briefs.map((b) => (
          <li key={b.slug}>
            <button
              onClick={() => open(b.slug)}
              disabled={opening === b.slug}
              className="group flex h-full w-full flex-col rounded-xl border border-border bg-surface/50 p-4 text-left transition-colors hover:border-brand/40 hover:bg-surface-hover disabled:opacity-60"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-medium leading-tight">{b.company}</span>
                <span className="shrink-0 text-[11px] text-faint">{relativeTime(b.updatedAt)}</span>
              </div>
              {b.role && <span className="mt-0.5 truncate text-sm text-muted">{b.role}</span>}
              {b.teaser && <span className="mt-2 line-clamp-2 text-xs leading-relaxed text-faint">{b.teaser}</span>}
              <span className="mt-3 flex flex-wrap gap-1">
                {b.kinds.map((k) => (
                  <span key={k} className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-faint">
                    {k}
                  </span>
                ))}
                {opening === b.slug && <span className="text-[10px] text-faint">opening…</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
