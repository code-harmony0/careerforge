import { Skeleton } from "@/components/ui/skeleton";

export default function InterviewLoading() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10" aria-label="Loading interview prep">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-96 max-w-full" />

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface/40 p-5">
            <Skeleton className="size-6 rounded" />
            <Skeleton className="mt-3 h-5 w-36" />
            <Skeleton className="mt-2 h-4 w-full" />
          </div>
        ))}
      </div>

      <div className="mt-8 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface/50 p-6">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-2 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
