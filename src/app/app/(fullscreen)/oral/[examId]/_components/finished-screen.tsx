"use client";

import type { ReactNode } from "react";

import { Notice } from "@/app/_components/notice";
import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon, LoadingIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import type { FinishFailure } from "@/lib/ui/finish-failure";
import { finishStageMessage, uploadPercent, type FinishStage } from "@/lib/ui/finish-progress";

/**
 * The end of the épreuve — which is four states, not one.
 *
 * PORT NOTE: the reference's `LoadingCard` and `ErrorCard` from
 * `evaluation-resultats.tsx`: a centred card on the fullscreen shell, a spinner
 * or a red disc, a heading and a paragraph of plain French. Reproduced as the
 * frame; what fills it is this project's, and it is more than the reference has
 * to say, because the reference never uploads anything and so cannot fail to.
 *
 * The happy path is three sentences rather than one (#86): compressing (before
 * the request is even built), the upload leaving the tab — with a bar, since
 * that is the one segment whose remainder the client can honestly draw — and
 * the correction itself. The words live in `lib/ui/finish-progress.ts` where
 * `node --test` can hold them to their states.
 *
 * The fourth state, failing to send, is the one worth writing carefully. The
 * audio exists only in this tab, so the message says so, and the retry is
 * offered **before** the way out — a candidate who reads "retour au tableau de
 * bord" first and clicks it has thrown away twenty minutes of recording.
 */

const PHASE_LABEL_FR: Record<"monologue" | "debate", string> = {
  monologue: "monologue",
  debate: "débat",
};

export function FinishedScreen({
  stage,
  submitError,
  droppedPhases,
  onRetry,
  onLeave,
  announcement,
}: {
  /** Where the wait has got to — compressing, uploading, being corrected. The
   *  orchestrator derives it (`finishStage`); this screen only says it. */
  stage: FinishStage;
  submitError: FinishFailure | null;
  droppedPhases: Array<"monologue" | "debate">;
  onRetry: () => void;
  onLeave: () => void;
  /**
   * The examiner's closing consigne (#37) — « Passer », while it plays (#59).
   *
   * Rendered here for one reason beyond consistency with the other boundaries:
   * the controller waits for this clip before handing the sitting over, so
   * without the button there is no way to cut it short — fifteen seconds of
   * unskippable audio between a candidate and their results. The second reason
   * is gone with the card: nothing prints the consigne any more, and this screen
   * says « Épreuve terminée » and « ne fermez pas cet onglet » in its own words.
   */
  announcement?: ReactNode;
}) {
  // No `submitError` guard: every path that sets the error also drops
  // `submitting`, so the stage is back to compressing and this is already null.
  const percent = uploadPercent(stage);

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
          <h1 className="mt-1 font-serif text-2xl font-semibold">
            {submitError ? (submitError.heading ?? "Correction interrompue") : "Épreuve terminée"}
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
            {submitError
              ? (submitError.lede ??
                (submitError.retryable
                  ? "Votre prestation attend d'être envoyée."
                  : "Votre prestation a bien été enregistrée, mais elle n'a pas pu être corrigée."))
              : finishStageMessage(stage)}
          </p>

          {/* The one segment whose remainder the client can honestly draw: the
              upload's own bytes. Silent to screen readers on purpose — the live
              paragraph above already said « Envoi… », and a figure that moves
              several times a second would announce itself as a metronome. */}
          {percent !== null && (
            <div
              aria-hidden="true"
              className="bg-primary/15 mt-4 h-1.5 w-56 overflow-hidden rounded-full"
            >
              <div
                className="bg-primary h-full rounded-full transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>

        {announcement}

        {droppedPhases.length > 0 && (
          <Notice tone="warning" title="Un enregistrement n'a pas pu être envoyé">
            {droppedPhases.length === 2
              ? "Vos deux prises de parole étaient trop volumineuses pour être envoyées."
              : `Votre ${PHASE_LABEL_FR[droppedPhases[0]]} était trop volumineux pour être envoyé.`}{" "}
            Cette partie sera corrigée à partir de sa transcription seule, sans écoute de votre
            prononciation, et comptera comme une durée de zéro seconde dans la pénalité de durée.
          </Notice>
        )}

        {submitError && (
          <Notice
            tone="danger"
            title={
              // The override exists for the one failure the defaults would lie
              // about (#86): a correction that timed out after a successful
              // envoi must not be headlined « L'envoi a échoué ».
              submitError.title ??
              (submitError.retryable
                ? "L'envoi a échoué"
                : "Cette épreuve ne peut pas être corrigée")
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
                  {/* « Abandonner » only where leaving actually abandons the
                      épreuve — the timeout's override drops the word, because
                      its sitting is accepted and may yet correct itself (#86). */}
                  {submitError.leaveLabel ??
                    (submitError.retryable
                      ? "Abandonner et revenir au tableau de bord"
                      : "Revenir au tableau de bord")}
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
