"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, AlertTriangle, RotateCcw, Maximize2, FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { readSavedCliId, resolveCliId } from "@/lib/saved-cli";
import { CostBadge } from "@/components/cost/cost-badge";

type PreviewState = "ready" | "stale" | "missing" | "failed";
type Template = { name: string; displayName: string; state: PreviewState };
type Info = { hasCv: boolean; selected: string; generatedAt: string | null; templates: Template[] };

export function CvTemplateGallery() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a regenerate so every thumbnail refetches. Previews live at the
  // same URL across regenerations, so without this the browser keeps showing the
  // previous CV even though the file on disk changed.
  const [version, setVersion] = useState(0);

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
      if (!r.ok) setError(d.error ?? "Generating previews failed.");
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
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            {busy ? "Rendering…" : anyPreview ? "Regenerate" : "Generate previews"}
          </button>
          <CostBadge kind="spend" size="xs" />
        </span>
      </div>

      {anyStale && !busy && (
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

      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {info.templates.map((t) => {
          const selected = t.name === info.selected;
          const hasPreview = t.state === "ready" || t.state === "stale";
          return (
            <div key={t.name} className="group">
              <button
                type="button"
                onClick={() => select(t.name)}
                aria-pressed={selected}
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
                      {t.state === "failed" ? (
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
                  <a
                    href={`/api/cv-preview?template=${encodeURIComponent(t.name)}&v=${version}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open full size"
                    className="text-faint transition-colors hover:text-brand"
                  >
                    <Maximize2 className="size-3.5" />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
