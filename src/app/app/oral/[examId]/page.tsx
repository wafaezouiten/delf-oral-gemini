import { notFound } from "next/navigation";

import { requireExamAccess } from "@/lib/auth/exam-guard";
import { findSittingTopicSlug } from "@/lib/db/sittings";
import { findTopic } from "@/lib/delf/topics";
import { ExamClient } from "./exam-client";

/**
 * The exam route. Server component: it resolves the subject and hands it down,
 * so the client bundle never has to ship the whole topic catalogue.
 *
 * The ownership check comes before anything else. Without it a signed-in
 * candidate could open `/app/oral/<someone else's id>`, sit the exam under that
 * id, and — since the transcript is only written at the end — the finish call
 * would be the first thing to notice. It refuses, but by then the candidate has
 * spent 20 minutes on an épreuve that was never going to be recorded.
 *
 * The subject comes from the SITTING, not from `?sujet=`, whenever there is a
 * sitting to read. It has to: `/api/live-token` builds the examiner's prompt
 * from the same row, and a page that trusted the query string instead would show
 * the candidate one document while the examiner argued about another. The query
 * string survives only as the fallback for the degraded ids `/api/exams` hands
 * out when there is no database — where there is no row to disagree with.
 */
export default async function OralExamPage({
  params,
  searchParams,
}: PageProps<"/app/oral/[examId]">) {
  const { examId } = await params;
  // Non-null only when ownership was established, so this cannot read a row the
  // candidate did not earn.
  const sittingId = await requireExamAccess(examId);

  const query = await searchParams;
  const requestedSlug = typeof query.sujet === "string" ? query.sujet : undefined;
  const sittingSlug = sittingId === null ? undefined : await findSittingTopicSlug(sittingId);

  const slug = sittingSlug ?? requestedSlug;
  const topic = slug ? findTopic(slug) : undefined;
  if (!topic) notFound();

  return <ExamClient examId={examId} topic={topic} />;
}
