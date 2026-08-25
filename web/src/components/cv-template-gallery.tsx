"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, AlertTriangle, RotateCcw, Maximize2, FileText, X, FileDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { readSavedCliId, resolveCliId } from "@/lib/saved-cli";
import { CostBadge } from "@/components/cost/cost-badge";

type PreviewState = "ready" | "stale" | "missing" | "failed";
type Template = { name: string; displayName: string; state: PreviewState };
type Info = { hasCv: boolean; generating: boolean; selected: string; generatedAt: string | null; templates: Template[] };

export function CvTemplateGallery() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a regenerate so every thumbnail refetches. Previews live at the
  // same URL across regenerations, so without this the browser keeps showing the
  // previous CV even though the file on disk changed.
  const [version, setVersion] = useState(0);
  // Which template is open in the full-size viewer. A 4-across grid of
  // page-shaped thumbnails is unreadable at body-text size — you cannot choose a
  // CV format you cannot read — so the thumbnail is an index and this is where
  // the template is actually judged.
  const [zoomed, setZoomed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/cv-templates");
      setInfo(await r.json());
    } catch {
      setError("Could not read your templates.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A run takes minutes (one agent pass, then a Chromium render per template)
  // and is owned by the server, not this component — so the poll is what shows
  // progress after a reload, in a second tab, or when the run was started
  // before this component mounted.
  useEffect(() => {
    if (!info?.generating) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [info?.generating, load]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  async function select(name: string) {
    if (!info) return;
    const previous = info.selected;
    setInfo({ ...info, selected: name }); // optimistic — reverted below on failure
    try {
      const r = await fetch("/api/cv-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error ?? "Could not save that template.");
        setInfo({ ...info, selected: previous });
      } else {
        setError(null);
      }
    } catch {
      setError("Could not save that template.");
      setInfo({ ...info, selected: previous });
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const cliId = readSavedCliId() || (await resolveCliId());
      if (!cliId) {
        setError("No AI CLI is set up yet — connect one from Config first.");
        return;
      }
      const r = await fetch("/api/cv-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cliId }),
      });
      const d = await r.json().catch(() => ({}));
      // 409 means a run is already going — that is the state the user wants to
      // see, not a failure. Anything else non-OK is a real error.
      if (r.status === 409) setError(null);
      else if (!r.ok) setError(d.error ?? "Generating previews failed.");
      else if (d.failed?.length) setError(`${d.failed.length} template(s) failed to render: ${d.failed.join(", ")}`);
      setVersion((v) => v + 1);
      await load();
    } catch {
      setError("Generating previews failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <div className="mt-6 text-sm text-muted">Loading templates…</div>;

  // Either this tab kicked it off, or the server says one is running.
  const running = busy || info.generating;

  if (!info.hasCv)
    return (
      <div className="mt-6 rounded-2xl border border-border bg-surface/30 p-8 text-center">
        <FileText className="mx-auto size-6 text-faint" />
        <p className="mt-3 text-sm text-muted">
          There is no <code className="text-foreground">cv.md</code> to preview yet. Add your CV on the Edit tab first.
        </p>
      </div>
    );

  const anyPreview = info.templates.some((t) => t.state === "ready" || t.state === "stale");
  const anyStale = info.templates.some((t) => t.state === "stale");

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {anyPreview
            ? "Your CV rendered in every template. Click one to make it your default."
            : "Generate previews to see your real CV in each template."}
        </p>
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={generate}
            disabled={running}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            {running ? "Rendering…" : anyPreview ? "Regenerate" : "Generate previews"}
          </button>
          <CostBadge kind="spend" size="xs" />
        </span>
      </div>

      {running && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-xs text-brand">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          Reading your CV, then rendering it into {info.templates.length} templates. This takes a few minutes — you can
          leave this page and come back.
        </div>
      )}

      {anyStale && !running && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          Your CV changed since these were rendered — regenerate to see the current version.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-400">
          {error}
        </div>
      )}

      <div className="mt-5 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {info.templates.map((t) => {
          const selected = t.name === info.selected;
          const hasPreview = t.state === "ready" || t.state === "stale";
          return (
            <div key={t.name} className="group">
              <button
                type="button"
                onClick={() => (hasPreview ? setZoomed(t.name) : select(t.name))}
                aria-pressed={selected}
                title={hasPreview ? `Preview ${t.displayName} full size` : t.displayName}
                className={cn(
                  "relative block w-full overflow-hidden rounded-2xl border bg-surface transition-colors",
                  selected ? "border-brand ring-2 ring-brand/30" : "border-border hover:border-brand/40",
                )}
              >
                <div className="aspect-[8.5/11] w-full bg-white">
                  {hasPreview ? (
                    // A PNG, not the PDF: the browser's built-in PDF viewer
                    // renders inconsistently in an <iframe>, is heavy seven
                    // times over, and does not render at all in headless
                    // Chromium. The PDF is what the full-size link opens.
                    // eslint-disable-next-line @next/next/no-img-element -- a local
                    // API-served preview, not a static asset next/image can optimize
                    <img
                      src={`/api/cv-preview?template=${encodeURIComponent(t.name)}&format=png&v=${version}`}
                      alt={`Your CV in the ${t.displayName} template`}
                      className={cn("size-full object-contain object-top", t.state === "stale" && "opacity-60")}
                    />
                  ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 bg-surface/40 text-faint">
                      {running ? (
                        <>
                          <Loader2 className="size-5 animate-spin" />
                          <span className="text-xs">Rendering…</span>
                        </>
                      ) : t.state === "failed" ? (
                        <>
                          <AlertTriangle className="size-5" />
                          <span className="text-xs">Failed to render</span>
                        </>
                      ) : (
                        <>
                          <FileText className="size-5" />
                          <span className="text-xs">No preview yet</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {selected && (
                  <span className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-full bg-brand text-brand-foreground">
                    <Check className="size-3.5" />
                  </span>
                )}
              </button>
              <div className="mt-2 flex items-center justify-between gap-2 px-1">
                <span className={cn("text-sm", selected ? "font-medium text-foreground" : "text-muted")}>
                  {t.displayName}
                </span>
                {hasPreview && (
                  <button
                    type="button"
                    onClick={() => setZoomed(t.name)}
                    title="Preview full size"
                    className="text-faint transition-colors hover:text-brand"
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${info.templates.find((t) => t.name === zoomed)?.displayName} preview`}
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex flex-col items-center overflow-auto bg-black/80 p-3 backdrop-blur-sm sm:p-6"
        >
          {/* Stop propagation so clicking the sheet itself does not dismiss it —
              only the backdrop does. */}
          <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-6xl flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-medium text-white">
                {info.templates.find((t) => t.name === zoomed)?.displayName}
              </h2>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/cv-preview?template=${encodeURIComponent(zoomed)}&v=${version}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/25 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/10 max-sm:min-h-[44px]"
                >
                  <FileDown className="size-3.5" /> Open PDF
                </a>
                <button
                  type="button"
                  onClick={() => {
                    select(zoomed);
                    setZoomed(null);
                  }}
                  disabled={zoomed === info.selected}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
                >
                  <Check className="size-3.5" />
                  {zoomed === info.selected ? "Current default" : "Use this template"}
                </button>
                <button
                  type="button"
                  onClick={() => setZoomed(null)}
                  aria-label="Close preview"
                  className="inline-flex items-center justify-center rounded-full border border-white/25 p-1.5 text-white transition-colors hover:bg-white/10 max-sm:min-h-[44px] max-sm:min-w-[44px]"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
            {/* Full-width PNG: the thumbnail is rendered at 1700px, so at page
                width it is readable rather than upscaled mush. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- API-served preview */}
            <img
              src={`/api/cv-preview?template=${encodeURIComponent(zoomed)}&format=png&v=${version}`}
              alt={`Your CV in the ${zoomed} template, full size`}
              className="w-full rounded-xl bg-white shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
