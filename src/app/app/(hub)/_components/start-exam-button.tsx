"use client";

import { primaryButton } from "@/app/_components/button-styles";
import { ArrowRightIcon } from "@/app/_components/po/icons";
import { useStartExam } from "@/app/_components/use-start-exam";

/**
 * The catalogue's launch CTA: creates the exam row, then navigates into it.
 *
 * Since #131 it sits on the sujet sheet's footer, with no dialog after it. The
 * POST-then-navigate flow it runs on is `useStartExam`, shared since #165 with
 * the correction header's « Recommencer » — see that hook for why entering an
 * épreuve here is a request rather than a link.
 */
export function StartExamButton({
  topicSlug,
  /** Only for the accessible name. Six buttons all reading "Passer l'épreuve" is
   *  a list a screen-reader user cannot choose from. */
  topicTitle,
}: {
  topicSlug: string;
  topicTitle: string;
}) {
  const { start, pending, error } = useStartExam();

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void start(topicSlug)}
        disabled={pending}
        aria-label={`Passer l'épreuve sur le sujet : ${topicTitle}`}
        className={primaryButton}
      >
        {pending ? "Ouverture…" : "Passer l'épreuve"}
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
