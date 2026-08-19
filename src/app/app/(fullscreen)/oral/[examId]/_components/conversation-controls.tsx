"use client";

import type { ReactNode } from "react";

import { AlertIcon, LoadingIcon, MicIcon, PencilIcon, StopIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import {
  micCopy,
  secondsToMonologueFloor,
  type MicState,
  type SpeakingPhase,
} from "@/lib/ui/po-player-view";

/**
 * The passation control bar, docked at the foot: the notes toggle on the left,
 * the mic — the one thing the candidate reaches for — big and centred, and the
 * way out of the épreuve on the right.
 *
 * PORT NOTE: `components/po/po-conversation-controls.tsx`, reproduced whole in
 * shape. What the controls *do* is this project's, and the difference is worth
 * stating because the buttons look identical:
 *
 * In the reference the mic opens and closes the ElevenLabs session — it is the
 * transport's switch, and "Terminer l'épreuve" calls the very same
 * `stopConversation`, so the two buttons are literally interchangeable. Here the
 * socket belongs to the controller and opens with the phase, so the mic is the
 * *advance* control: during the monologue it ends the monologue and hands over
 * to the débat, during the débat it ends the épreuve. That makes the two buttons
 * genuinely different for the first time, and "Terminer l'épreuve" is therefore
 * disabled during the monologue — the DELF has no path from an exposé straight
 * to a correction, and a button that silently skipped the débat would be
 * offering one.
 *
 * The monologue's five-minute floor (`canAdvanceEarly`) is shown as time still
 * owed under the mic rather than baked into a long button label. The reference
 * has no analogue; this project's previous screen carried it as the button's
 * own text, which meant the label changed every sixty seconds under a candidate
 * who might be reading it.
 */
export function ConversationControls({
  phase,
  canAdvance,
  connecting,
  recording,
  awaitingStart = false,
  startDisabled = false,
  closing = false,
  elapsed,
  hasNotes,
  notesOpen,
  onToggleNotes,
  onStart,
  onAdvance,
  emptyTranscript = false,
  onRetryTranscription,
  devPanel,
}: {
  phase: SpeakingPhase;
  /** The state machine's own rule: may this phase be ended now? */
  canAdvance: boolean;
  connecting: boolean;
  recording: boolean;
  /**
   * The part has not begun: the button starts it rather than ending it.
   *
   * This is the one state in which the control's meaning is reversed, which is
   * why it carries a visible word from here on — an icon that is a square in one
   * state and a circle in another does not tell a candidate whether they are
   * about to start speaking or stop.
   */
  awaitingStart?: boolean;
  /** Armed, but not yet startable: the examiner is still giving the consigne. */
  startDisabled?: boolean;
  /**
   * The click has been taken and the part is ending: the examiner is delivering
   * its closing sentence (#55).
   *
   * Without this the control fell back to `locked` — `canAdvance` goes false the
   * moment the handshake starts — and printed « Encore 0 min avant de pouvoir
   * conclure » over a monologue that was already concluding.
   */
  closing?: boolean;
  elapsed: number;
  hasNotes: boolean;
  notesOpen: boolean;
  onToggleNotes: () => void;
  /** « Enregistrer »: start the clock, the recording and the session. */
  onStart: () => void;
  onAdvance: () => void;
  /** The monologue was ended with no speech on it, and the phase is held open. */
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
  /** DEVELOPMENT ONLY — the transcription panel, which belongs beside the
   *  empty-transcript notice rather than under the conversation (#36). */
  devPanel?: ReactNode;
}) {
  // Armed outranks everything: a part that has not begun is not connecting, and
  // it is not locked behind a floor it has not started counting towards. Closing
  // comes next, and for the same kind of reason: a part that is ending is not
  // waiting for a floor it passed, whatever `canAdvance` says about it.
  const state: MicState = awaitingStart
    ? "armed"
    : closing
      ? "closing"
      : connecting
        ? "connecting"
        : canAdvance
          ? "recording"
          : "locked";
  const { hint, label, button } = micCopy(phase, state, secondsToMonologueFloor(elapsed));
  const armed = state === "armed";
  const locked = state === "locked";
  /** Nothing the candidate presses now changes what happens next, so the control
   *  stops looking like an offer. */
  const inert = locked || state === "closing";

  return (
    <div className="border-border bg-card/95 relative shrink-0 border-t backdrop-blur">
      {/* The controls stay in a centred 760px column; the alert is pushed out of
          it, into the bar's own right-hand corner — see the `xl:absolute` on it
          below. Positioning it against THIS element rather than the column is
          what "extreme right" means: the column ends at 996px on a 1280 screen,
          the bar ends at 1280.

          It is only pulled out from `xl` up, because that is where the margin
          beside the column is wide enough to hold it. Narrower than that it
          stays in the row beside « Terminer l'épreuve », which is the most
          right-hand place that exists when there is no margin to move into. */}
      <div className="mx-auto flex w-full max-w-[47.5rem] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        {hasNotes && (
          <button
            type="button"
            onClick={onToggleNotes}
            aria-pressed={notesOpen}
            aria-label="Mes notes de préparation"
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3.5 text-xs font-semibold transition-colors",
              notesOpen
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            <PencilIcon className="size-3.5" />
            <span className="hidden sm:inline">Mes notes</span>
          </button>
        )}

        <div className="flex flex-1 flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={armed ? onStart : onAdvance}
            disabled={armed ? startDisabled : inert || connecting}
            aria-label={label}
            className={cn(
              "relative flex items-center justify-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              // Armed, the control is a pill with a word in it: it is starting
              // something, and the round stop-button shape reads as ending one.
              armed
                ? "bg-danger h-11 rounded-full px-5 text-sm font-semibold text-white hover:opacity-90"
                : "size-14 rounded-full",
              !armed &&
                (recording && !inert
                  ? "bg-danger text-white hover:opacity-90"
                  : inert
                    ? "bg-muted text-muted-foreground border-border border"
                    : "bg-primary text-primary-foreground hover:opacity-90"),
            )}
          >
            {/* The ring says "you are live", so it follows the microphone and
                not the button's enabled state: it keeps pulsing through the
                locked minutes, when the candidate is very much being recorded.
                Never while armed — nothing is being captured yet, and a pulsing
                ring over a part that has not started is the same false claim the
                recording badge is written to avoid. */}
            {recording && !armed && (
              <span className="po-ring border-danger absolute -inset-1 rounded-full border-2" aria-hidden />
            )}
            {armed ? (
              <>
                <MicIcon className="size-4" aria-hidden />
                {button}
              </>
            ) : connecting || state === "closing" ? (
              // The same spinner the connection uses, for the same reason: the
              // épreuve is waiting on the examiner and the candidate is not.
              <LoadingIcon className="size-6 animate-spin" />
            ) : locked ? (
              <MicIcon className="size-6" />
            ) : (
              <StopIcon className="size-6" />
            )}
          </button>
          {/* Not a live region: it changes once a minute during the locked
              window, and a screen reader reciting the countdown over the
              examiner is the fault the clock's milestones exist to avoid. The
              button's own name carries the same fact on demand, and the close is
              announced by the status line above the controls. */}
          <span className="text-muted-foreground text-center text-[0.6875rem]">{hint}</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onAdvance}
            disabled={phase !== "debate" || !canAdvance}
            title={
              phase === "debate"
                ? undefined
                : "Le débat doit avoir lieu avant la fin de l'épreuve."
            }
            className="bg-primary text-primary-foreground h-9 shrink-0 rounded-md px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Terminer l&apos;épreuve
          </button>

          {/* `xl:absolute` lifts the pair out of the flex row and into the bar's
              corner. That also stops them costing the mic any width: in flow the
              mic is centred in what is left over, so on a wide screen the alert
              appearing used to slide it 131px sideways. Above `xl` it no longer
              moves at all.

              The alert and the development panel share one wrapper because they
              are about the same thing — the transcript, and its being empty —
              and because they must move together: two separately-positioned
              elements in one corner is how they end up on top of each other. */}
          {(emptyTranscript || devPanel) && (
            <div className="flex flex-wrap items-center gap-2 xl:absolute xl:top-1/2 xl:right-6 xl:-translate-y-1/2">
              {emptyTranscript && (
                <div
                  role="alert"
                  className="border-warning/40 bg-warning-subtle text-warning flex items-center gap-2.5 rounded-md border px-3 py-1.5"
                >
                  <AlertIcon className="size-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold whitespace-nowrap">
                      Transcription vide
                    </p>
                    <p className="text-[0.6875rem] leading-snug whitespace-nowrap">
                      Chronomètre arrêté.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onRetryTranscription}
                    className="border-warning/50 bg-card hover:bg-muted shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors"
                  >
                    Réessayer
                  </button>
                </div>
              )}
              {devPanel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
