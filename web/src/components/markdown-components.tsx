import type { Components } from "react-markdown";

/**
 * The shared react-markdown renderer overrides for report content.
 *
 * One definition, because the same report text is rendered in two places: the
 * report page (`report-view.tsx`, a server component) and the job page
 * (`jobs/[id]/page.tsx`, a client component streaming the same evaluation
 * output). Defining the table wrapper in only one of them is how `/jobs/[id]`
 * ended up still crushing its tables after `/pipeline/[id]` was fixed. Same
 * reasoning as `report-sections.mjs`: the two places that used to hold this
 * independently could drift, so they no longer hold it independently.
 *
 * No hooks and no "use client", so it imports cleanly into either kind.
 */

/**
 * Evaluation-table rows (STAR+R Story, Match with CV, ...) run up to eight
 * columns of real prose, not short data cells. At the reading column's width
 * every cell collapses to roughly one word per line.
 *
 * The floor is on the CELLS, not the table. A table-level `min-width` has to be
 * picked for the worst case, and then the two-column "Field | Value" tables in
 * the same report inherit it and scroll for no reason. A per-cell minimum
 * scales with the column count on its own: two columns stay inside the reading
 * width, eight add up past it and the container scrolls.
 *
 * Scrolling the table rather than widening the page is deliberate. Widening far
 * enough to fit eight prose columns would push the report's own prose past a
 * comfortable measure, trading one readability problem for another.
 */
export const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full [&_td]:min-w-32 [&_th]:min-w-32">{children}</table>
    </div>
  ),
};
