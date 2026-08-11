import { ResultsClient } from "./results-client";

/**
 * Results. Rendered client-side from the evaluation the finish call returned
 * (stashed in sessionStorage), so a result is visible whether or not a database
 * is configured. With Neon connected the same evaluation is also persisted, and
 * a future revision can read it back here for permanent history.
 */
export default async function ResultsPage({ params }: PageProps<"/app/results/[examId]">) {
  const { examId } = await params;
  return <ResultsClient examId={examId} />;
}
