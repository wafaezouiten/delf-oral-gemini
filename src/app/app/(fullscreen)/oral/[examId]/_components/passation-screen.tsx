"use client";

import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { phaseDurationSeconds } from "@/lib/delf/phases";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { DEBATE_TRANSCRIPT_COPY } from "@/lib/ui/debate-transcript";
import {
  MONOLOGUE_TITLE,
  DEBATE_TITLE,
  passationStatus,
  poKicker,
  shortPartLabel,
  type SpeakingPhase,
} from "@/lib/ui/po-player-view";
import { ConversationScene } from "./conversation-scene";
import { ConversationControls } from "./conversation-controls";
import { DebateTranscript } from "./debate-transcript";
import { NotesDrawer } from "./notes-drawer";

/**
 * The passation, whole: chrome, scene, status card, control bar, notes drawer.
 *
 * PORT NOTE: this is the reference's `phase === "conversation"` branch of
 * `simulateur-client.tsx` plus the layout half of `conversation-simulateur.tsx`,
 * assembled into one screen so the orchestrator below stays a phase switch. The
 * reference splits them because its transport component owns the session; here
 * the session belongs to `ExamController`, which leaves this file with no state
 * of its own and nothing to own it for.
 *
 * **The débat prints its exchange; the monologue does not (#48).** The reference
 * has no transcript feed anywhere, and this screen reproduced that: the exchange
 * is spoken, not printed, and watching a transcript arrive is the fastest way to
 * stop listening to the examiner. That argument was never wrong — it is now
 * outweighed in one phase and left standing in the other, and the two halves
 * come apart cleanly:
 *
 *  - **The monologue keeps the quiet card.** Verified against the live service:
 *    during a manual-VAD activity nothing is transcribed until the floor is
 *    released, so the whole exposé arrives at once at the end. A feed there
 *    would sit empty for seven minutes and then print everything at the moment
 *    the phase is over — a panel that looks broken, then a panel that is too
 *    late to read.
 *  - **The débat runs on automatic VAD**, so both sides stream turn by turn, and
 *    a candidate who missed what the examiner just objected to can read it.
 *    This is a training simulator rather than the épreuve, and being able to see
 *    the objection is worth more here than the fidelity of not seeing it. The
 *    distraction risk is real and accepted, which is why « Masquer » exists: the
 *    reference's behaviour is one click away and stays available all through the
 *    phase.
 *
 * The feed takes the status card's place rather than stacking under it. Both at
 * once costs the scene its room on a phone, and the card's sentence is guidance
 * for before the exchange starts — so it is handed to the feed, which prints it
 * until the first turn lands.
 */
export function PassationScreen({
  phase,
  elapsed,
  remaining,
  recording,
  examinerSpeaking,
  connected,
  connecting,
  canAdvance,
  examinerStatus,
  candidateStatus,
  notes,
  notesOpen,
  onToggleNotes,
  transcript,
  transcriptOpen,
  onToggleTranscript,
  onAdvance,
  onExit,
  emptyTranscript = false,
  onRetryTranscription,
  awaitingConsigne = false,
  badges,
  notices,
  announcement,
  devPanel,
}: {
  phase: SpeakingPhase;
  elapsed: number;
  remaining: number;
  recording: boolean;
  examinerSpeaking: boolean;
  connected: boolean;
  connecting: boolean;
  canAdvance: boolean;
  examinerStatus: string;
  candidateStatus: string;
  notes: string;
  notesOpen: boolean;
  onToggleNotes: () => void;
  /** The whole exam transcript. Only the débat's half of it is ever shown here. */
  transcript: readonly TranscriptEntry[];
  /** Open by default, and only consulted during the débat. See the block above. */
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
  onAdvance: () => void;
  onExit: () => void;
  /** The monologue was ended with no speech recorded — the advance was refused. */
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
  /** The recording and connection badges. See the strip below for why not the chrome. */
  badges: ReactNode;
  /** Controller failures — a lost connection, a dead microphone. */
  notices?: ReactNode;
  /**
   * The examiner's spoken consigne for this phase (#37).
   *
   * Above the scene, under the notices, so it reads in the order it matters: what
   * has gone wrong, then what you have been asked to do, then who is speaking.
   * It stays for the whole phase, folded down to a line once it has been heard —
   * see `AnnouncementCard` for why it does not disappear.
   */
  announcement?: ReactNode;
  /**
   * The phase has not started: its consigne is still being spoken, or is waiting
   * for a click (#37). The clock is at its full length and nothing is recorded, so
   * the status card must not say either has begun.
   */
  awaitingConsigne?: boolean;
  /** Development-only diagnostics. Never rendered in production. */
  devPanel?: ReactNode;
}) {
  const total = phaseDurationSeconds(phase);
  const status = passationStatus(phase, connected, awaitingConsigne);
  const hasNotes = notes.trim().length > 0;
  const partTitle = phase === "monologue" ? MONOLOGUE_TITLE : DEBATE_TITLE;
  const showTranscript = phase === "debate" && transcriptOpen;

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
      <SimulatorTopBar
        kicker={poKicker(shortPartLabel(partTitle))}
        currentStep={2}
        onBack={onExit}
        right={
          <>
            <TimerRing remaining={remaining} total={total} phase={phase} />
            <button
              type="button"
              onClick={onExit}
              aria-label="Quitter l'épreuve"
              className="border-danger/30 text-danger hover:bg-danger-subtle flex size-8.5 shrink-0 items-center justify-center rounded-full border transition-colors"
            >
              <ExitIcon className="size-4" />
            </button>
          </>
        }
      />

      {/* The two badges get a strip of their own rather than a place in the
          chrome's right slot. The reference has no analogue for either, so there
          is no layout to copy — and the slot is the wrong home for them: it
          already carries the clock and the exit, and « Reconnexion, l'épreuve
          continue » is a sentence, not a chip. Hiding them below `lg` to make
          them fit would hide the recording indicator on a phone, which is the
          one screen where "you can check it" matters most. */}
      <div className="border-border bg-card/60 flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-5">
        {badges}
      </div>

      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-[47.5rem] flex-1 flex-col justify-center gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          {notices}
          {announcement}

          <ConversationScene
            phase={phase}
            examinerSpeaking={examinerSpeaking}
            examinerStatus={examinerStatus}
            candidateRecording={recording && !examinerSpeaking}
            candidateStatus={candidateStatus}
            candidateStatusUrgent={remaining <= 60}
            elapsed={elapsed}
            total={total}
          />

          {showTranscript ? (
            <DebateTranscript
              transcript={transcript}
              hint={status.body}
              onHide={onToggleTranscript}
            />
          ) : (
            <div className="border-border bg-card rounded-lg border border-dashed p-6 text-center">
              <h2 className="text-[0.84375rem] font-semibold">{status.title}</h2>
              <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-xs leading-relaxed">
                {status.body}
              </p>
              {/* The way back, and only in the phase that has something to show.
                  On the card rather than in the control bar: it is the control
                  bar's job to end the phase, and a candidate who has just hidden
                  the feed looks where the feed was. */}
              {phase === "debate" && (
                <button
                  type="button"
                  onClick={onToggleTranscript}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted mt-3.5 rounded-md border px-3 py-1.5 text-[0.6875rem] font-semibold transition-colors"
                >
                  {DEBATE_TRANSCRIPT_COPY.show}
                </button>
              )}
            </div>
          )}
        </div>

        <ConversationControls
          phase={phase}
          canAdvance={canAdvance}
          connecting={connecting}
          recording={recording}
          elapsed={elapsed}
          hasNotes={hasNotes}
          notesOpen={notesOpen}
          onToggleNotes={onToggleNotes}
          onAdvance={onAdvance}
          emptyTranscript={emptyTranscript}
          onRetryTranscription={onRetryTranscription}
          // Handed down rather than rendered here: it belongs beside the
          // empty-transcript notice, which lives inside the bar (#36).
          devPanel={devPanel}
        />

        {hasNotes && (
          <NotesDrawer open={notesOpen} notes={notes} onClose={onToggleNotes} />
        )}
      </main>
    </div>
  );
}
