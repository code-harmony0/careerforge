"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The per-item add/drop question a pdf run stops on.
 *
 * modes/pdf.md step 14a makes the agent ask before putting anything on the CV
 * that cv.md does not support. A headless run has no channel to be asked on, so
 * the backend stops between saving the CV and rendering it, and this is where
 * the question actually reaches the user. No PDF exists while this is showing.
 */
export function CvDecisionsPanel({
  pending,
  onResolved,
}: {
  pending: { reportNum: string; format: string; items: string[] };
  onResolved: (result: { pendingCvAdditions: string[] }) => void;
}) {
  // Default DROP, deliberately. The user is being asked precisely because
  // cv.md does not support these, so an item they never answer must not ride
  // onto the CV by inaction.
  const [choices, setChoices] = useState<Record<string, "add" | "drop">>(
    Object.fromEntries(pending.items.map((t) => [t, "drop" as const])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cv-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportNum: pending.reportNum,
          format: pending.format,
          decisions: Object.entries(choices).map(([tag, action]) => ({ tag, action })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not finish the CV.");
        return;
      }
      onResolved({ pendingCvAdditions: data.pendingCvAdditions ?? [] });
    } catch {
      setError("Could not reach career-ops to finish the CV.");
    } finally {
      setBusy(false);
    }
  }

  const keeping = Object.values(choices).filter((c) => c === "add").length;

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-medium text-foreground">
            {pending.items.length} thing{pending.items.length === 1 ? "" : "s"} on this CV{" "}
            {pending.items.length === 1 ? "isn't" : "aren't"} in your cv.md
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Decide each one. Nothing is rendered until you do.
          </p>
        </div>
      </div>

      <ul className="mt-3 divide-y divide-border">
        {pending.items.map((tag) => (
          <li key={tag} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0 break-words text-sm text-foreground">{tag}</span>
            <span className="flex shrink-0 gap-1">
              {(
                [
                  ["add", "Keep", Check],
                  ["drop", "Drop", X],
                ] as const
              ).map(([action, label, Icon]) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => setChoices((c) => ({ ...c, [tag]: action }))}
                  aria-pressed={choices[tag] === action}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                    choices[tag] === action
                      ? action === "add"
                        ? "border-transparent bg-brand text-brand-foreground"
                        : "border-transparent bg-foreground/80 text-background"
                      : "border-border text-muted hover:text-foreground",
                  )}
                >
                  <Icon className="size-3" />
                  {label}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      <button
        type="button"
        onClick={apply}
        disabled={busy}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy
          ? "Rendering…"
          : `Keep ${keeping}, drop ${pending.items.length - keeping} — make the PDF`}
      </button>
    </div>
  );
}
