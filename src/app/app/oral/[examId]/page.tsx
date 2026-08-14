import { notFound } from "next/navigation";

import { requireExamAccess } from "@/lib/auth/exam-guard";
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
 */
export default async function OralExamPage({
  params,
  searchParams,
}: PageProps<"/app/oral/[examId]">) {
  const { examId } = await params;
  await requireExamAccess(examId);

  const query = await searchParams;
  const slug = typeof query.sujet === "string" ? query.sujet : undefined;
  const topic = slug ? findTopic(slug) : undefined;
  if (!topic) notFound();

  return <ExamClient examId={examId} topic={topic} />;
}
