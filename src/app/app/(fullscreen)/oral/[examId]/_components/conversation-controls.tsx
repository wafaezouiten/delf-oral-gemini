import type { ReactNode } from "react";

import { AlertIcon, LoadingIcon, MicIcon, PencilIcon, StopIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { controlsView, type MicButtonView } from "@/lib/ui/conversation-controls";
import type { SpeakingPhase } from "@/lib/ui/po-player-view";

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
  canAdvance: boolean;
  connecting: boolean;
  recording: boolean;
  awaitingStart?: boolean;
  startDisabled?: boolean;
  closing?: boolean;
  hasNotes: boolean;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onStart: () => void;
  onAdvance: () => void;
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
  devPanel?: ReactNode;
}) {
  // What each control is and whether it may be pressed is
  // `lib/ui/conversation-controls.ts`, tested; this maps a look to classes.
  const view = controlsView({
    phase,
    canAdvance,
    connecting,
    recording,
    awaitingStart,
    startDisabled,
    closing,
    emptyTranscript,
    hasDevPanel: Boolean(devPanel),
  });

  return (
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
        {hasNotes && <NotesButton open={notesOpen} onToggle={onToggleNotes} />}

        <div className="flex flex-1 flex-col items-center gap-1.5">
          <MicButton mic={view.mic} onStart={onStart} onAdvance={onAdvance} />
          {/* Not a live region. It used to change every minute, counting a
              monologue down to its floor, and a screen reader reciting that over
              the examiner is the fault the clock's milestones exist to avoid.
              The floor is gone (#171), but the reason holds for the close this
              line still describes: the status line above the controls is what
              says that one out loud. */}
          <span className="text-muted-foreground text-center text-[0.6875rem]">
            {view.mic.hint}
          </span>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onAdvance}
            disabled={view.finish.disabled}
            title={view.finish.title}
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
          {view.corner && (
            <div className="flex flex-wrap items-center gap-2 xl:absolute xl:inset-y-0 xl:right-6 xl:content-center">
              {emptyTranscript && <EmptyTranscriptAlert onRetry={onRetryTranscription} />}
              {devPanel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MIC_LOOK: Record<MicButtonView["look"], string> = {
  armed: "bg-danger h-10 rounded-full px-5 text-sm font-semibold text-white hover:opacity-90",
  recording: "bg-danger size-12 rounded-full text-white hover:opacity-90",
  inert: "bg-muted text-muted-foreground border-border size-12 rounded-full border",
  primary: "bg-primary text-primary-foreground size-12 rounded-full hover:opacity-90",
};

const MIC_ICON: Record<MicButtonView["icon"], ReactNode> = {
  mic: <MicIcon className="size-4" aria-hidden />,
  loading: <LoadingIcon className="size-5 animate-spin" />,
  stop: <StopIcon className="size-5" />,
};

/** The one button: « Enregistrer » while armed, the stop once the part runs. */
function MicButton({
  mic,
  onStart,
  onAdvance,
}: {
  mic: MicButtonView;
  onStart: () => void;
  onAdvance: () => void;
}) {
  return (
    <button
      type="button"
      onClick={mic.action === "start" ? onStart : onAdvance}
      disabled={mic.disabled}
      aria-label={mic.label}
      className={cn(
        "relative flex items-center justify-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        MIC_LOOK[mic.look],
      )}
    >
      {/* The ring says "you are live", so it follows the microphone and
                not the button's enabled state — it keeps pulsing through the
                closing handshake, when the candidate is still being recorded.
                Never while armed: nothing is being captured yet, and a pulsing
                ring over a part that has not started is the same false claim the
                recording badge is written to avoid. */}
      {mic.pulsing && (
        <span
          className="po-ring border-danger absolute -inset-1 rounded-full border-2"
          aria-hidden
        />
      )}
      {MIC_ICON[mic.icon]}
      {mic.look === "armed" && mic.text}
    </button>
  );
}

/** Opens the préparation's notes over the passation; pressed while they are open. */
function NotesButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label="Mes notes de préparation"
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3.5 text-xs font-semibold transition-colors",
        open
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      <PencilIcon className="size-3.5" />
      <span className="hidden sm:inline">Mes notes</span>
    </button>
  );
}

/** The transcript came back empty and the clock stopped (#206): say so, offer again. */
function EmptyTranscriptAlert({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning-subtle text-warning flex items-center gap-2.5 rounded-md border px-3 py-1.5"
    >
      <AlertIcon className="size-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs font-semibold whitespace-nowrap">Transcription vide</p>
        <p className="text-[0.6875rem] leading-snug whitespace-nowrap">Chronomètre arrêté.</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="border-warning/50 bg-card hover:bg-muted shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors"
      >
        Réessayer
      </button>
    </div>
  );
}
