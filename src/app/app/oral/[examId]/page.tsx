import { notFound } from "next/navigation";

import { findTopic } from "@/lib/delf/topics";
import { ExamClient } from "./exam-client";

/**
 * The exam route. Server component: it resolves the subject and hands it down,
 * so the client bundle never has to ship the whole topic catalogue.
 */
export default async function OralExamPage({
  params,
  searchParams,
}: PageProps<"/app/oral/[examId]">) {
  const { examId } = await params;
  const query = await searchParams;
  const slug = typeof query.sujet === "string" ? query.sujet : undefined;
  const topic = slug ? findTopic(slug) : undefined;
  if (!topic) notFound();

  return <ExamClient examId={examId} topic={topic} />;
}
