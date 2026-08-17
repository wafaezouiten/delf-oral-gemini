"use client";

import type { ReactNode } from "react";

import { Notice } from "@/app/_components/notice";
import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon, LoadingIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import type { FinishFailure } from "@/lib/ui/finish-failure";

/**
 * The end of the épreuve — which is three states, not one.
 *
 * PORT NOTE: the reference's `LoadingCard` and `ErrorCard` from
 * `evaluation-resultats.tsx`: a centred card on the fullscreen shell, a spinner
 * or a red disc, a heading and a paragraph of plain French. Reproduced as the
 * frame; what fills it is this project's, and it is more than the reference has
 * to say, because the reference never uploads anything and so cannot fail to.
 *
 * The three states are: compressing (before the request is even built), sending
 * and being corrected, and failing to send. The third is the one worth writing
 * carefully. The audio exists only in this tab, so the message says so, and the
 * retry is offered **before** the way out — a candidate who reads "retour au
 * tableau de bord" first and clicks it has thrown away twenty minutes of
 * recording.
 */

const PHASE_LABEL_FR: Record<"monologue" | "debate", string> = {
  monologue: "monologue",
  debate: "débat",
};

export function FinishedScreen({
  submitting,
  submitError,
  droppedPhases,
  onRetry,
  onLeave,
  announcement,
}: {
  submitting: boolean;
  submitError: FinishFailure | null;
  droppedPhases: Array<"monologue" | "debate">;
  onRetry: () => void;
  onLeave: () => void;
  /**
   * The examiner's closing consigne (#37).
   *
   * Rendered here for two reasons beyond consistency with the other boundaries.
   * The controller waits for this clip before handing the sitting over, so without
   * the card there is no way to cut it short — fifteen seconds of unskippable
   * audio between a candidate and their results. And it is the text equivalent:
   * this screen says « Épreuve terminée » and « ne fermez pas cet onglet » on its
   * own, but the consigne should be readable in the words it was spoken in.
   */
  announcement?: ReactNode;
}) {
  return (
    <main className="bg-background flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl space-y-5 py-10">
        <div className="border-border bg-card flex flex-col items-center rounded-lg border px-8 py-12 text-center">
          {submitError ? (
            <span className="bg-danger-subtle text-danger flex size-14 items-center justify-center rounded-full">
              <AlertIcon className="size-7" />
            </span>
          ) : (
            <LoadingIcon className="text-primary size-9 animate-spin" />
          )}

          <Kicker className="mt-6">DELF B2 · Production orale</Kicker>
          <h1 className="font-serif mt-1 text-2xl font-semibold">
            {submitError ? "Correction interrompue" : "Épreuve terminée"}
          </h1>

          {/* A live region only while there is no failure. Once `submitError` is
              set, this paragraph's text changes at the same moment the assertive
              <Notice> below mounts, and a screen reader would receive two
              overlapping statements about one event. The notice wins, because it
              is the one carrying the explanation and the button. The sentence
              stays on screen; it just stops announcing. */}
          <p
            className="text-muted-foreground mt-3 max-w-[42ch] text-sm leading-relaxed"
            role={submitError ? undefined : "status"}
          >
            {submitting
              ? "L'examinateur analyse votre passation selon la grille officielle du DELF B2. Cela peut prendre une minute ; ne fermez pas cet onglet."
              : submitError
                ? submitError.retryable
                  ? "Votre prestation attend d'être envoyée."
                  : "Votre prestation a bien été enregistrée, mais elle n'a pas pu être corrigée."
                : // Not idle: the recordings are being compressed before they
                  // are sent, which takes a few seconds for a full sitting.
                  "Préparation de votre enregistrement…"}
          </p>
        </div>

        {announcement}

        {droppedPhases.length > 0 && (
          <Notice tone="warning" title="Un enregistrement n'a pas pu être envoyé">
            {droppedPhases.length === 2
              ? "Vos deux prises de parole étaient trop volumineuses pour être envoyées."
              : `Votre ${PHASE_LABEL_FR[droppedPhases[0]]} était trop volumineux pour être envoyé.`}{" "}
            Cette partie sera corrigée à partir de sa transcription seule, sans
            écoute de votre prononciation, et comptera comme une durée de zéro
            seconde dans la pénalité de durée.
          </Notice>
        )}

        {submitError && (
          <Notice
            tone="danger"
            title={
              submitError.retryable
                ? "L'envoi a échoué"
                : "Cette épreuve ne peut pas être corrigée"
            }
            action={
              <div className="flex flex-wrap gap-2">
                {/* The retry is offered only when it could work. A button under
                    a 413 or a 422 would send the same bytes to the same
                    refusal, and the candidate would sit through it twice. */}
                {submitError.retryable && (
                  <button type="button" onClick={onRetry} className={dangerButton}>
                    Réessayer l&apos;envoi
                  </button>
                )}
                <button type="button" onClick={onLeave} className={secondaryButton}>
                  {submitError.retryable
                    ? "Abandonner et revenir au tableau de bord"
                    : "Revenir au tableau de bord"}
                </button>
              </div>
            }
          >
            {submitError.message}
          </Notice>
        )}
      </div>
    </main>
  );
}
