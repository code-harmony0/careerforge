import { InterviewForm } from "@/components/interview/interview-form";

export const dynamic = "force-dynamic";

export default function InterviewPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-lg font-semibold">Interview prep</h1>
      <p className="mt-1 text-sm text-faint">
        Company-specific prep briefs, time-blocked prep plans, and offer/negotiation walkthroughs — run against your real CV and profile.
      </p>
      <InterviewForm />
    </div>
  );
}
