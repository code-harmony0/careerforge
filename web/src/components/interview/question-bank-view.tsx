"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search, Target } from "lucide-react";
import { cn } from "@/lib/cn";
import { CostBadge } from "@/components/cost/cost-badge";

// Every question you might be asked, in one filterable place — and a box to
// answer each one into.
//
// The whole surface renders with ZERO model calls. Filtering, status and the
// answer feedback are all local or arithmetic, which is what makes it a screen
// you can leave open. A dashboard that costs money to look at is one nobody
// opens twice.

type Question = {
  id: string;
  question: string;
  axis?: string;
  tag?: string;
  round?: string;
  source?: string;
  status?: string;
  asked?: number;
  last?: string;
};

type Facet = { value: string; count: number };
type Facets = { axis: Facet[]; tag: Facet[]; status: Facet[]; round: Facet[] };

type Analysis = {
  wordCount: number;
  spokenEstimate: string;
  speakingWpm: number;
  lengthVerdict: "short" | "ok" | "long";
  fillers: { phrase: string; count: number }[];
  fillerCount: number;
  hedges: { phrase: string; count: number }[];
  hedgeCount: number;
  repeated: { word: string; count: number }[];
  leadsWithResult: boolean;
  cvTermsMentioned: string[];
  unsupportedClaims: string[];
};

const STATUS_LABEL: Record<string, string> = {
  new: "Not practised",
  "🔴": "Struggled",
  "🟡": "Shaky",
  "✅": "Solid",
};

const STATUS_CYCLE = ["new", "🔴", "🟡", "✅"];

export function QuestionBankView() {
  const [all, setAll] = useState<Question[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ axis: [], tag: [], status: [], round: [] });
  const [exists, setExists] = useState(true);
  const [filters, setFilters] = useState<{ axis: string; tag: string; status: string }>({ axis: "", tag: "", status: "" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Question | null>(null);

  const load = useCallback(() => {
    fetch("/api/questions")
      .then((r) => r.json())
      .then((d) => {
        setAll(Array.isArray(d.questions) ? d.questions : []);
        setFacets(d.facets ?? { axis: [], tag: [], status: [], round: [] });
        setExists(Boolean(d.exists));
      })
      .catch(() => setAll([]));
  }, []);

  useEffect(load, [load]);

  // Filtering client-side rather than refetching: the whole bank is a few
  // hundred short rows, so a round-trip per chip click would be slower than
  // the filter itself and would make the UI feel worse for no benefit.
  const shown = useMemo(() => {
    let rows = all ?? [];
    for (const key of ["axis", "tag", "status"] as const) {
      const want = filters[key];
      if (want) rows = rows.filter((q) => (q[key] ?? (key === "status" ? "new" : "")) === want);
    }
    const q = query.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.question.toLowerCase().includes(q));
    return rows;
  }, [all, filters, query]);

  const setStatus = useCallback(
    async (id: string, status: string) => {
      setAll((prev) => prev?.map((q) => (q.id === id ? { ...q, status } : q)) ?? prev);
      setSelected((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
      const res = await fetch("/api/questions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      // The optimistic update above is a lie if the write failed, so reload
      // rather than leave the screen showing a status that is not on disk.
      if (!res.ok) load();
    },
    [load],
  );

  if (all === null) return <p className="py-8 text-sm text-faint">Loading question bank…</p>;

  if (!exists || all.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <Target className="mx-auto size-6 text-faint" />
        <p className="mt-3 text-sm font-medium">No questions yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-faint">
          Seed it from the bundled tech packs. They are public MIT question sets, so this costs nothing to run:
        </p>
        <pre className="mx-auto mt-3 w-fit rounded-lg bg-[var(--pre-bg)] px-3 py-2 text-left font-mono text-xs">
          node question-bank.mjs seed --stack react-native,typescript
        </pre>
        <p className="mt-3 text-xs text-faint">
          Real questions from your interviews land here too, once you run a debrief.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">
        <div className="flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5 focus-within:border-brand/50">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search questions…"
            aria-label="Search questions"
            className="min-w-0 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-faint"
          />
          <span className="shrink-0 text-xs text-faint">
            {shown.length}/{all.length}
          </span>
        </div>

        <div className="mt-3 space-y-1.5">
          <FacetRow label="Axis" options={facets.axis} value={filters.axis} onChange={(v) => setFilters((f) => ({ ...f, axis: v }))} />
          <FacetRow label="Stack" options={facets.tag.slice(0, 8)} value={filters.tag} onChange={(v) => setFilters((f) => ({ ...f, tag: v }))} />
          <FacetRow
            label="Status"
            options={facets.status}
            value={filters.status}
            onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
            render={(v) => STATUS_LABEL[v] ?? v}
          />
        </div>

        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-faint">Nothing matches those filters.</li>}
          {shown.map((q) => (
            <li key={q.id}>
              <button
                onClick={() => setSelected(q)}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover",
                  selected?.id === q.id && "bg-brand/10",
                )}
              >
                <span className="mt-0.5 w-4 shrink-0 text-center text-xs" title={STATUS_LABEL[q.status || "new"]}>
                  {q.status && q.status !== "new" ? q.status : "○"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-snug">{q.question}</span>
                  <span className="mt-0.5 block text-[11px] text-faint">
                    {q.tag || q.axis}
                    {q.asked ? ` · asked ${q.asked}×` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        {selected ? (
          <AnswerPanel key={selected.id} question={selected} onStatus={setStatus} />
        ) : (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-faint">
            Pick a question to write your answer.
          </div>
        )}
      </div>
    </div>
  );
}

function FacetRow({
  label,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  options: Facet[];
  value: string;
  onChange: (v: string) => void;
  render?: (v: string) => string;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-[11px] uppercase tracking-wide text-faint">{label}</span>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            // Clicking the active chip clears it. Without that the only way out
            // of a filter is to guess that there is a reset somewhere.
            onClick={() => onChange(active ? "" : o.value)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              active ? "border-brand bg-brand-soft text-brand-text" : "border-border text-muted hover:border-brand/40",
            )}
          >
            {render ? render(o.value) : o.value}
            <span className="ml-1 text-faint">{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function AnswerPanel({ question, onStatus }: { question: Question; onStatus: (id: string, s: string) => void }) {
  const [answer, setAnswer] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/questions/answer?id=${encodeURIComponent(question.id)}&question=${encodeURIComponent(question.question)}`)
      .then((r) => r.json())
      .then((d) => {
        setAnswer(d.answer ?? "");
        setAnalysis(d.analysis ?? null);
        setState("idle");
      })
      .catch(() => setState("error"));
  }, [question.id, question.question]);

  // Debounced autosave. An interview answer is written in fits and starts, and
  // an explicit Save button is one more thing to forget before closing the tab.
  const save = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        setState("saving");
        try {
          const res = await fetch("/api/questions/answer", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: question.id, answer: text, question: question.question }),
          });
          const d = await res.json();
          if (!res.ok) throw new Error();
          setAnalysis(d.analysis ?? null);
          setState("saved");
        } catch {
          setState("error");
        }
      }, 700);
    },
    [question.id, question.question],
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div className="sticky top-6 space-y-3">
      <div className="rounded-xl border border-border bg-surface/50 p-4">
        <p className="text-sm font-medium leading-snug">{question.question}</p>
        <p className="mt-1 text-[11px] text-faint">
          {question.axis}
          {question.tag ? ` · ${question.tag}` : ""}
          {question.source ? ` · ${question.source}` : ""}
        </p>

        <div className="mt-3 flex flex-wrap gap-1">
          {STATUS_CYCLE.map((s) => (
            <button
              key={s}
              onClick={() => onStatus(question.id, s)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                (question.status || "new") === s
                  ? "border-brand bg-brand-soft text-brand-text"
                  : "border-border text-muted hover:border-brand/40",
              )}
            >
              {s === "new" ? "○" : s} {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface/50 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">Your answer</span>
          <span className="flex items-center gap-1.5 text-[11px] text-faint">
            {state === "saving" && <Loader2 className="size-3 animate-spin" />}
            {state === "saved" && <Check className="size-3 text-emerald-500" />}
            {state === "saved" ? "Saved" : state === "saving" ? "Saving" : state === "error" ? "Save failed" : ""}
          </span>
        </div>
        <textarea
          value={answer}
          onChange={(e) => {
            setAnswer(e.target.value);
            save(e.target.value);
          }}
          rows={9}
          placeholder="Say it the way you'd say it out loud…"
          aria-label="Your answer"
          className="w-full resize-y rounded-lg border border-border bg-surface/70 px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand/50"
        />
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
          Feedback below is computed locally <CostBadge kind="free" size="xs" />
        </p>
      </div>

      {analysis && <AnalysisPanel a={analysis} />}
    </div>
  );
}

function AnalysisPanel({ a }: { a: Analysis }) {
  const lengthTone =
    a.lengthVerdict === "ok" ? "text-emerald-500" : a.lengthVerdict === "long" ? "text-amber-500" : "text-muted";
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface/50 p-4 text-xs">
      <Line label="Spoken length">
        <span className={lengthTone}>{a.spokenEstimate}</span>
        <span className="text-faint">
          {" "}
          · {a.wordCount} words at ~{a.speakingWpm} wpm
          {a.lengthVerdict === "long" ? " — trim it" : a.lengthVerdict === "short" ? " — probably stops too early" : ""}
        </span>
      </Line>

      <Line label="Opening">
        {a.leadsWithResult ? (
          <span className="text-emerald-500">Leads with the result</span>
        ) : (
          <span className="text-amber-500">Winds up before the point — put the outcome first</span>
        )}
      </Line>

      {(a.fillerCount > 0 || a.hedgeCount > 0) && (
        <Line label="Padding">
          {a.fillerCount > 0 && <span>{a.fillerCount} filler</span>}
          {a.fillerCount > 0 && a.hedgeCount > 0 && <span className="text-faint"> · </span>}
          {/* Hedges are called out separately because they do different damage:
              a filler is noise, a hedge undercuts the claim it sits on. */}
          {a.hedgeCount > 0 && <span className="text-amber-500">{a.hedgeCount} hedge</span>}
          <span className="text-faint">
            {" "}
            ({[...a.fillers, ...a.hedges].slice(0, 4).map((f) => `"${f.phrase}"`).join(", ")})
          </span>
        </Line>
      )}

      {a.repeated.length > 0 && (
        <Line label="Repeated">
          <span className="text-faint">{a.repeated.map((r) => `${r.word} ×${r.count}`).join(", ")}</span>
        </Line>
      )}

      <Line label="From your CV">
        {a.cvTermsMentioned.length ? (
          <span className="text-faint">{a.cvTermsMentioned.slice(0, 6).join(", ")}</span>
        ) : (
          <span className="text-faint">Nothing from your CV yet — name the real tools you used</span>
        )}
      </Line>

      {a.unsupportedClaims.length > 0 && (
        // Phrased as a question, never an accusation. Keyword matching WILL
        // produce false positives, and a check that feels like it is calling
        // you a liar gets ignored — which would kill the one piece of feedback
        // here that no competing tool offers.
        <div className="mt-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <p className="font-medium text-amber-500">Is this in your CV?</p>
          <p className="mt-1 text-faint">
            {a.unsupportedClaims.map((c) => `"${c}"`).join(", ")} {a.unsupportedClaims.length === 1 ? "does" : "do"} not
            appear in <code className="text-[10px]">cv.md</code>. If the number is real, add it there — otherwise you are
            about to say it to someone who will ask a follow-up.
          </p>
        </div>
      )}
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap gap-x-1.5">
      <span className="w-24 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}
