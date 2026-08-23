import { InterviewWorkspace } from "@/components/interview/interview-workspace";

export const dynamic = "force-dynamic";

// The interview destination is a READING surface, not a form page. It used to
// be capped at max-w-2xl (672px) with the generated brief stuffed into a 384px
// scroll box — which is how a 3,000-word, table-heavy document became
// unreadable and always opened somewhere in its own middle.
//
// The width now belongs to whichever pane is showing: the form stays narrow
// because a form should, and the document gets the page.
export default function InterviewPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <InterviewWorkspace />
    </div>
  );
}
