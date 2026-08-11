"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Creates the exam row, then navigates into it.
 *
 * The row is created BEFORE navigation so the exam page always has a real id to
 * report against, rather than minting one client-side and reconciling later.
 */
export function StartExamButton({ topicSlug }: { topicSlug: string }) {
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
      setError("Impossible de démarrer l'épreuve. Réessayez.");
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? "Ouverture…" : "Passer l'épreuve"}
      </button>
      {error && <span className="text-danger text-xs">{error}</span>}
    </div>
  );
}
