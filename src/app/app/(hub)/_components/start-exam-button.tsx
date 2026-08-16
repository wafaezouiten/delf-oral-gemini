"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { primaryButton } from "@/app/_components/button-styles";
import { ArrowRightIcon } from "@/app/_components/po/icons";

/**
 * Creates the exam row, then navigates into it.
 *
 * The row is created BEFORE navigation so the exam page always has a real id to
 * report against, rather than minting one client-side and reconciling later.
 *
 * PORT NOTE: this is the action behind the reference's launch dialog CTA. There
 * the CTA is a `<Link href={simulateurHref}>` — the reference's simulateur takes
 * its sujet in a query param, so entering an épreuve is a navigation and nothing
 * more. Here an épreuve is a row, so it is a POST first and a navigation second,
 * and the button therefore has a pending state and a failure the link never had.
 */
export function StartExamButton({
  topicSlug,
  /** Only for the accessible name. Six buttons all reading "Passer l'épreuve" is
   *  a list a screen-reader user cannot choose from. */
  topicTitle,
  label = "Passer l'épreuve",
}: {
  topicSlug: string;
  topicTitle: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
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
      setError(
        "L'épreuve n'a pas pu être ouverte. Vérifiez votre connexion, puis réessayez.",
      );
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={start}
        disabled={pending}
        aria-label={`${label} sur le sujet : ${topicTitle}`}
        className={primaryButton}
      >
        {pending ? "Ouverture…" : label}
        {!pending && <ArrowRightIcon className="size-3.5" />}
      </button>
      {error && (
        <p role="alert" className="text-danger text-xs leading-relaxed">
          {error}
        </p>
      )}
    </div>
  );
}
