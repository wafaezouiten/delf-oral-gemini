import type { ReactNode } from "react";

import { Notice } from "@/app/_components/notice";
import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon, LoadingIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import type { FinishFailure } from "@/lib/ui/finish-failure";
import { finishedView, type FinishStage, type FinishedView } from "@/lib/ui/finish-progress";

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

export function FinishedScreen({
  stage,
  submitError,
  droppedPhases,
  onRetry,
  onLeave,
  announcement,
}: {
  stage: FinishStage;
  submitError: FinishFailure | null;
  droppedPhases: Array<"monologue" | "debate">;
  onRetry: () => void;
  onLeave: () => void;
  announcement?: ReactNode;
}) {
  // Every word and every fallback is `finishedView`'s, tested; this prints it.
  const view = finishedView(stage, submitError, droppedPhases);

  return (
    <main className="bg-background flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl space-y-5 py-10">
        <FinishCard view={view} />

        {announcement}

        {/* The awaiting sentence says the tab is disposable; this is the
            sentence made actionable (#86). Leaving unmounts the screen, which
            cancels the poll — the correction finishes on the server either
            way, and the historique is where the sentence promised it. */}
        {view.canLeaveWhileWaiting && (
          <div className="flex justify-center">
            <button type="button" onClick={onLeave} className={secondaryButton}>
              Revenir au tableau de bord
            </button>
          </div>
        )}

        {view.dropped && (
          <Notice tone="warning" title="Un enregistrement n'a pas pu être envoyé">
            {view.dropped}
          </Notice>
        )}

        {view.failure && (
          <FailureNotice failure={view.failure} onRetry={onRetry} onLeave={onLeave} />
        )}
      </div>
    </main>
  );
}

/** The centred card: a spinner or a red disc, the heading, the sentence, the bar. */
function FinishCard({ view }: { view: FinishedView }) {
  return (
    <div className="border-border bg-card flex flex-col items-center rounded-lg border px-8 py-12 text-center">
      {view.failed ? (
        <span className="bg-danger-subtle text-danger flex size-14 items-center justify-center rounded-full">
          <AlertIcon className="size-7" />
        </span>
      ) : (
        <LoadingIcon className="text-primary size-9 animate-spin" />
      )}

      <Kicker className="mt-6">DELF B2 · Production orale</Kicker>
      <h1 className="mt-1 font-serif text-2xl font-semibold">{view.heading}</h1>

      {/* A live region only while there is no failure. Once `submitError` is
          set, this paragraph's text changes at the same moment the assertive
          <Notice> below mounts, and a screen reader would receive two
          overlapping statements about one event. The notice wins, because it
          is the one carrying the explanation and the button. The sentence
          stays on screen; it just stops announcing. */}
      <p
        className="text-muted-foreground mt-3 max-w-[42ch] text-sm leading-relaxed"
        role={view.live ? "status" : undefined}
      >
        {view.lede}
      </p>

      {/* The one segment whose remainder the client can honestly draw: the
          upload's own bytes. Silent to screen readers on purpose — the live
          paragraph above already said « Envoi… », and a figure that moves
          several times a second would announce itself as a metronome. */}
      {view.percent !== null && (
        <div
          aria-hidden="true"
          className="bg-primary/15 mt-4 h-1.5 w-56 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: `${view.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The failure, with the retry offered BEFORE the way out: a candidate who
 * reads "retour au tableau de bord" first and clicks it has thrown away
 * twenty minutes of recording.
 */
function FailureNotice({
  failure,
  onRetry,
  onLeave,
}: {
  failure: NonNullable<FinishedView["failure"]>;
  onRetry: () => void;
  onLeave: () => void;
}) {
  return (
    <Notice
      tone="danger"
      title={failure.title}
      action={
        <div className="flex flex-wrap gap-2">
          {failure.retryable && (
            <button type="button" onClick={onRetry} className={dangerButton}>
              Réessayer l&apos;envoi
            </button>
          )}
          <button type="button" onClick={onLeave} className={secondaryButton}>
            {failure.leaveLabel}
          </button>
        </div>
      }
    >
      {failure.message}
    </Notice>
  );
}
