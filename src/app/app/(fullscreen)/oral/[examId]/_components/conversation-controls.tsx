"use client";

import type { ReactNode } from "react";

import { AlertIcon, LoadingIcon, MicIcon, PencilIcon, StopIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { micCopy, micState, type MicState, type SpeakingPhase } from "@/lib/ui/po-player-view";

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
 * The mic also used to have a fifth state: a monologue that had not yet run the
 * minute `canAdvanceEarly` demanded showed a greyed-out control with a countdown
 * under it. The floor is gone (#171), so the control is an offer in every state
 * a candidate can reach — which is what the reference's always was.
 *
 * **The round control is 48 px rather than 56, and the armed pill 40 rather than
 * 44 (#183).** Both are still well past the 44 px a touch target needs, and the
 * red disc was reading as the loudest thing on a screen whose subject is the
 * examiner: it is the control you press twice in twenty minutes, at the end of
 * each half. Shrinking it also gives the hint under it and the two buttons
 * beside it room in the 56 px bar on a phone, where the row was wrapping.
 */
export function ConversationControls({
  phase,
  canAdvance,
  connecting,
  recording,
  awaitingStart = false,
  startDisabled = false,
  closing = false,
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
  /**
   * Armed, but not yet startable: the examiner is still giving the consigne.
   *
   * The control keeps « Enregistrer » and its hint throughout and only greys
   * out (#176) — the candidate reads one label for the whole part-that-has-not-
   * begun, and the only thing that changes when the voice ends is that the
   * button becomes pressable. What is happening meanwhile is said next to the
   * examiner, by `examinerStatus`, and by the consigne's own « Passer » button.
   */
  startDisabled?: boolean;
  /**
   * The click has been taken and the part is ending: the examiner is delivering
   * its closing sentence (#55).
   *
   * It has to be said here rather than inferred: `canAdvance` goes false the
   * moment the handshake starts, and with no floor left to explain that
   * (#171) the control would read a part that is already concluding as one the
   * candidate could still press — the spinner, the disabled state and « Terminé »
   * all come from this flag alone.
   */
  closing?: boolean;
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
  // The ladder is `micState`'s, next to the copy it selects and tested there:
  // its last branch is a fall-through, and what lands in it is exactly what this
  // control will claim about a state nobody thought of (#176).
  const state: MicState = micState({ awaitingStart, closing, connecting });
  const { hint, label, button } = micCopy(phase, state);
  const armed = state === "armed";
  /** Nothing the candidate presses now changes what happens next, so the control
   *  stops looking like an offer. */
  const inert = state === "closing";

  return (
    // `z-20` on the bar, and it is the dev popovers that need it (#163).
    // `backdrop-blur` makes this element a stacking context, so a popover
    // inside it cannot climb out with a `z-` of its own however large — its
    // twenty is counted among the bar's children. The débat's scene row is
    // `sticky top-0 z-10` inside a `<main>` that is `relative` with no
    // z-index, so no stacking context is formed there and that ten is counted
    // against the page. The two were never in the same contest: the scene card
    // painted over the prompt being edited, mid-word. Raising the bar puts
    // both of its popovers above the column, and leaves the notes drawer's
    // `z-40` where it was, covering the bar as it is meant to.
    <div className="border-border bg-card/95 relative z-20 shrink-0 border-t backdrop-blur">
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
                ? "bg-danger h-10 rounded-full px-5 text-sm font-semibold text-white hover:opacity-90"
                : "size-12 rounded-full",
              !armed &&
                (recording && !inert
                  ? "bg-danger text-white hover:opacity-90"
                  : inert
                    ? "bg-muted text-muted-foreground border-border border"
                    : "bg-primary text-primary-foreground hover:opacity-90"),
            )}
          >
            {/* The ring says "you are live", so it follows the microphone and
                not the button's enabled state — it keeps pulsing through the
                closing handshake, when the candidate is still being recorded.
                Never while armed: nothing is being captured yet, and a pulsing
                ring over a part that has not started is the same false claim the
                recording badge is written to avoid. */}
            {recording && !armed && (
              <span
                className="po-ring border-danger absolute -inset-1 rounded-full border-2"
                aria-hidden
              />
            )}
            {armed ? (
              <>
                <MicIcon className="size-4" aria-hidden />
                {button}
              </>
            ) : connecting || state === "closing" ? (
              // The same spinner the connection uses, for the same reason: the
              // épreuve is waiting on the examiner and the candidate is not.
              <LoadingIcon className="size-5 animate-spin" />
            ) : (
              <StopIcon className="size-5" />
            )}
          </button>
          {/* Not a live region. It used to change every minute, counting a
              monologue down to its floor, and a screen reader reciting that over
              the examiner is the fault the clock's milestones exist to avoid.
              The floor is gone (#171), but the reason holds for the close this
              line still describes: the status line above the controls is what
              says that one out loud. */}
          <span className="text-muted-foreground text-center text-[0.6875rem]">{hint}</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onAdvance}
            disabled={phase !== "debate" || !canAdvance}
            title={
              phase === "debate" ? undefined : "Le débat doit avoir lieu avant la fin de l'épreuve."
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
              elements in one corner is how they end up on top of each other.

              `xl:inset-y-0` with `content-center` rather than the half-height
              offset and translate that did the same centring before (#163),
              and the difference is what the dev popover measures itself
              against. A popover inside this cluster is positioned against IT
              from `xl` up and against the bar below it, so a cap written in
              percentages meant two different heights on two sides of one
              breakpoint. Spanning the bar makes them the same height, and the
              cap true at every width. The row still sits in the middle of the
              bar — `items-center` centres one line, `content-center` centres
              two — and the translate is gone with the offset, which also stops
              this cluster forming a containing block of its own. */}
          {(emptyTranscript || devPanel) && (
            <div className="flex flex-wrap items-center gap-2 xl:absolute xl:inset-y-0 xl:right-6 xl:content-center">
              {emptyTranscript && (
                <div
                  role="alert"
                  className="border-warning/40 bg-warning-subtle text-warning flex items-center gap-2.5 rounded-md border px-3 py-1.5"
                >
                  <AlertIcon className="size-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold whitespace-nowrap">Transcription vide</p>
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
