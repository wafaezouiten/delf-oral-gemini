import { requireOwnedExam } from "@/lib/auth/exam-guard";
import { ResultsClient } from "./results-client";

/**
 * Results. Rendered client-side from the evaluation the finish call returned
 * (stashed in sessionStorage), so a result is visible whether or not a database
 * is configured. With Neon connected the same evaluation is also persisted, and
 * a future revision can read it back here for permanent history.
 *
 * The ownership check is here now rather than when that revision lands. Today it
 * guards a route whose data happens to come from the visitor's own browser; the
 * moment the page reads the correction back from Neon, the gate is already in
 * place instead of being the thing someone remembers to add.
 */
export default async function ResultsPage({ params }: PageProps<"/app/results/[examId]">) {
  const { examId } = await params;
  await requireOwnedExam(examId);

  return <ResultsClient examId={examId} />;
}
