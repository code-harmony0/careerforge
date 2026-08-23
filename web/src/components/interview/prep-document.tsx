"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { Check, Copy, Maximize2, Minimize2, Printer, List } from "lucide-react";
import { cn } from "@/lib/cn";
import { remarkCleanInterviewHeadings } from "@/lib/interview-doc.mjs";

// The reader for a finished prep brief or plan.
//
// This replaces a <pre className="max-h-96 overflow-auto"> that rendered a
// 3,000-word, table-heavy document as raw monospace markdown inside a 384px
// scroll box — which is why a finished run left the user parked in the middle
// of section 5 with no way to navigate. Three things fix that, in order of how
// much they matter:
//
//  1. The document gets the page, not a box. No max-height, no inner scroll.
//  2. A jump rail with live position tracking, so "where am I" is answered
//     without scrolling to find out.
//  3. Focus mode + print, because this is read on a phone in a lobby twenty
//     minutes before the call, not admired inside an app shell.
//
// Anchors come from rehype-slug (github-slugger under it) rather than anything
// hand-rolled, and the rail is built by reading those ids back off the rendered
// headings. That keeps the rail structurally incapable of disagreeing with the
// document — and it means a run whose output drifts from the mode file's
// template simply yields fewer headings, never a broken page.

type Props = {
  markdown: string;
  /** Company, or whatever names this document. */
  title: string;
  /** Role. Optional — a manual run may not have one. */
  subtitle?: string;
  /** "Prep brief" / "Prep plan" — what kind of document this is. */
  kindLabel?: string;
  /** Save-to-disk control and friends, rendered into the header's action row. */
  actions?: React.ReactNode;
};

type Entry = { id: string; text: string; level: number };

// Evaluation and round-breakdown tables run 5–7 columns of real prose. Squeezed
// into the reading column they collapse to one word per line, so each table
// gets its own horizontal scroll container rather than widening the page — the
// same trade report-view.tsx makes for the same reason.
const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px]">{children}</table>
    </div>
  ),
};

const REMARK = [remarkGfm, remarkCleanInterviewHeadings];
const REHYPE = [rehypeSlug];

export function PrepDocument({ markdown, title, subtitle, kindLabel, actions }: Props) {
  const [outline, setOutline] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState("");
  const [copied, setCopied] = useState(false);
  const [focus, setFocus] = useState(false);
  const [progress, setProgress] = useState(0);
  const articleRef = useRef<HTMLElement>(null);

  // Read the outline back off what was actually rendered. Deriving it from the
  // DOM rather than from a second parse of the same markdown is what makes the
  // rail and the document provably the same list of sections.
  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    // h2/h3 only. h4 still gets an id from rehype-slug (so a link into one
    // works), but interview-prep.md emits every individual likely question as
    // an h4 — listing those turned a 12-entry rail into a 40-entry one, which
    // is a second document to read rather than a way around the first.
    const found = Array.from(el.querySelectorAll<HTMLElement>("h2[id], h3[id]")).map((n) => ({
      id: n.id,
      text: (n.textContent ?? "").trim(),
      level: Number(n.tagName[1]),
    }));
    setOutline(found);
  }, [markdown]);

  // Which section is being read. Track the topmost heading that has crossed
  // the header, rather than "whatever is most visible" — with sections of wildly
  // different lengths, most-visible flickers between neighbours on every scroll
  // frame, and a rail highlight that flickers is worse than none.
  useEffect(() => {
    if (outline.length === 0) return;
    const nodes = outline
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      let current = nodes[0];
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= 120) current = node;
        else break;
      }
      setActiveId(current.id);
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      setProgress(scrollable > 0 ? Math.min(1, doc.scrollTop / scrollable) : 0);
    };
    // getBoundingClientRect on every heading, on every scroll event, forces a
    // layout each time. One read per animation frame is all the highlight can
    // actually show.
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [outline]);

  // Focus mode hides the app shell via a root class (the sidebar and chat
  // console are siblings of this tree, so React-local state can't reach them).
  // The cleanup is what guarantees the class can't outlive the component and
  // leave the whole app chromeless after navigating away.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("co-focus-read", focus);
    return () => root.classList.remove("co-focus-read");
  }, [focus]);

  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is permission-gated and fails outright in some contexts.
      // Silent is right here: the text is on screen and selectable, so a
      // scary error toast would overstate a non-problem.
    }
  }, [markdown]);

  const jump = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  }, []);

  const hasRail = outline.length > 1;
  const body = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    ),
    [markdown],
  );

  return (
    <div className="co-prep-doc">
      {/* Reading progress. A long document's most basic unanswered question is
          "how much is left" — one 2px line answers it for free. */}
      <div className="co-print-hide fixed inset-x-0 top-0 z-40 h-0.5 bg-transparent">
        <div
          className="h-full bg-brand transition-[width] duration-150 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <header className="co-print-hide sticky top-0 z-30 -mx-4 mb-6 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold leading-tight">{title}</h2>
            {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
          </div>
          {kindLabel && (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
              {kindLabel}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <IconButton onClick={copy} label={copied ? "Copied" : "Copy markdown"}>
              {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
            </IconButton>
            <IconButton onClick={() => window.print()} label="Print or save as PDF">
              <Printer className="size-4" />
            </IconButton>
            <IconButton onClick={() => setFocus((f) => !f)} label={focus ? "Exit focus (Esc)" : "Focus mode"}>
              {focus ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </IconButton>
          </div>
        </div>
        {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
      </header>

      {/* Print header — the sticky one above is hidden on paper, and a printed
          brief with no company name on it is useless in a stack of three. */}
      <div className="co-print-only mb-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>

      {hasRail && (
        <details className="co-print-hide mb-4 rounded-lg border border-border bg-surface/50 xl:hidden">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
            <List className="size-4 text-faint" />
            Jump to section
            <span className="ml-auto text-xs text-faint">{outline.length}</span>
          </summary>
          <ul className="max-h-72 overflow-auto border-t border-border p-1">
            {outline.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => jump(s.id)}
                  className={cn(
                    "line-clamp-2 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-hover hover:text-foreground",
                    s.level > 2 && "pl-5 text-xs",
                  )}
                >
                  {s.text}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className={cn(hasRail && "xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10")}>
        {hasRail && (
          <nav className="co-print-hide hidden xl:block" aria-label="Document sections">
            <ul className="sticky top-24 max-h-[calc(100vh-8rem)] space-y-0.5 overflow-y-auto border-l border-border pr-2">
              {outline.map((s) => {
                const active = s.id === activeId;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => jump(s.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "-ml-px line-clamp-2 w-full border-l-2 py-1 pr-1 text-left text-[13px] leading-snug transition-colors",
                        s.level > 2 ? "pl-5 text-[12px]" : "pl-3",
                        active
                          ? "border-brand font-medium text-foreground"
                          : "border-transparent text-faint hover:border-border hover:text-muted",
                      )}
                    >
                      {s.text}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <article ref={articleRef} className="report-prose min-w-0 max-w-[68ch]">
          {body}
        </article>
      </div>
    </div>
  );
}

function IconButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}
