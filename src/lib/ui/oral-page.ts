import { findTopic, type OralTopic } from "@/lib/delf/topics";

/**
 * Which sujet the exam page opens on, and which examiner (#234).
 *
 * The subject comes from the SITTING, not from `?sujet=`, whenever there is a
 * sitting to read: `/api/live-token` builds the examiner's prompt from the
 * same row, and a page that trusted the query string instead would show the
 * candidate one document while the examiner argued about another. The query
 * string survives only as the fallback for the degraded ids `/api/exams`
 * hands out when there is no database — where there is no row to disagree
 * with. Null is the page's 404.
 */
export function oralPageSubject(
  sitting: { topicSlug: string | null; examinerModel: string | null } | null,
  query: Record<string, string | string[] | undefined>,
): { topic: OralTopic; storedExaminerModel: string | null } | null {
  const requested = typeof query.sujet === "string" ? query.sujet : undefined;
  const slug = sitting?.topicSlug ?? requested;
  const topic = slug ? findTopic(slug) : undefined;
  if (!topic) return null;
  return { topic, storedExaminerModel: sitting?.examinerModel ?? null };
}
