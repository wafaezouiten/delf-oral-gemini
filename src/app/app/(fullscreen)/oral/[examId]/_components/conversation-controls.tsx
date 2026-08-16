"use client";

import { AlertIcon, LoadingIcon, MicIcon, PencilIcon, StopIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { micCopy, secondsToMonologueFloor, type SpeakingPhase } from "@/lib/ui/po-player-view";

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
  elapsed,
  hasNotes,
  notesOpen,
  onToggleNotes,
  onAdvance,
  emptyTranscript = false,
  onRetryTranscription,
}: {
  phase: SpeakingPhase;
  /** The state machine's own rule: may this phase be ended now? */
  canAdvance: boolean;
  connecting: boolean;
  recording: boolean;
  elapsed: number;
  hasNotes: boolean;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onAdvance: () => void;
  /** The monologue was ended with no speech on it, and the phase is held open. */
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
}) {
  const state = connecting ? "connecting" : canAdvance ? "recording" : "locked";
  const { hint, label } = micCopy(phase, state, secondsToMonologueFloor(elapsed));
  const locked = state === "locked";

  return (
    <div className="border-border bg-card/95 shrink-0 border-t backdrop-blur">
      {/* The alert shares this row, to the right of « Terminer l'épreuve ».

          The mic was briefly pinned to the row's centre so it could not be
          pushed sideways by the alert appearing. Measuring killed that: out of
          flow, the mic no longer reserved any width, so the right-hand group
          slid under it and « Terminer l'épreuve » ended up drawn across the
          microphone. In flow it is, and the alert is kept compact — one short
          line and a two-word button — so the shift it causes is small. */}
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
            onClick={onAdvance}
            disabled={locked || connecting}
            aria-label={label}
            className={cn(
              "relative flex size-14 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed",
              recording && !locked
                ? "bg-danger text-white hover:opacity-90"
                : locked
                  ? "bg-muted text-muted-foreground border-border border"
                  : "bg-primary text-primary-foreground hover:opacity-90",
            )}
          >
            {/* The ring says "you are live", so it follows the microphone and
                not the button's enabled state: it keeps pulsing through the
                locked minutes, when the candidate is very much being recorded. */}
            {recording && (
              <span className="po-ring border-danger absolute -inset-1 rounded-full border-2" aria-hidden />
            )}
            {connecting ? (
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
              button's own name carries the same fact on demand. */}
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

          {/* To the right of « Terminer l'épreuve », in the same row. It wraps
              under the button only when the viewport genuinely cannot hold both,
              and even then the mic does not move — it is pinned above. */}
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
        </div>
      </div>
    </div>
  );
}
