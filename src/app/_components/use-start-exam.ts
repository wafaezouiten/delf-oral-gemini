"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Opening an épreuve: create the row, then navigate into it.
 *
 * The row is created BEFORE navigation so the exam page always has a real id to
 * report against, rather than minting one client-side and reconciling later.
 *
 * PORT NOTE: this is the action behind the reference's launch CTA. There the
 * CTA is a `<Link href={simulateurHref}>` — the reference's simulateur takes
 * its sujet in a query param, so entering an épreuve is a navigation and nothing
 * more. Here an épreuve is a row, so it is a POST first and a navigation second,
 * and every control that opens one therefore has a pending state and a failure
 * the link never had.
 *
 * It is a hook rather than a component because two buttons now open an épreuve
 * and they look nothing alike: the catalogue's full-width « Passer l'épreuve »
 * (`StartExamButton`) and the correction header's 32 px « Recommencer » (#165).
 * What they share is this — the POST, the pending flag, the one sentence said
 * when it fails — and sharing it is what keeps a second copy of the fetch, with
 * its own idea of what the response looks like, from existing.
 */
export function useStartExam() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(topicSlug: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicSlug }),
      });
      if (!response.ok) throw new Error(await response.text());
      const { examId } = (await response.json()) as { examId: string };
      router.push(`/app/oral/${examId}?sujet=${topicSlug}`);
    } catch (cause) {
      console.error(cause);
      setError("L'épreuve n'a pas pu être ouverte. Vérifiez votre connexion, puis réessayez.");
      setPending(false);
    }
  }

  // `pending` is deliberately never lowered on success: the navigation is what
  // ends this state, and clearing it first would flash the idle label back onto
  // a button whose page is already leaving.
  return { start, pending, error };
}
