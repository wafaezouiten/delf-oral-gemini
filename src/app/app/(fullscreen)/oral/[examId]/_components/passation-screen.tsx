"use client";

import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { phaseDurationSeconds } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { DEBATE_TRANSCRIPT_COPY } from "@/lib/ui/debate-transcript";
import {
  MONOLOGUE_TITLE,
  DEBATE_TITLE,
  SITE_FOOTER,
  partieKicker,
  passationStatus,
  poKicker,
  topbarStep,
  type SpeakingPhase,
} from "@/lib/ui/po-player-view";
import { ConversationControls } from "./conversation-controls";
import { DebateTranscript } from "./debate-transcript";
import { ExposePlan } from "./expose-plan";
import { NotesDrawer } from "./notes-drawer";

/**
 * The passation: the sujet the candidate is speaking about, in front of them
 * while they speak about it.
 *
 * **What this screen used to be, and why it changed.** It was a pair of examiner
 * and candidate avatars with a status card underneath, and the sujet was left
 * behind on the préparation screen. That reproduced the reference faithfully and
 * it was the wrong thing to reproduce: a candidate delivering a seven-minute
 * argued exposé about a document cannot see the document, cannot see the plan
 * they were told to follow, and is watching two faces that convey nothing the
 * status line does not already say in words. The avatars are gone; the sujet, the
 * plan and the record control take the room they were using.
 *
 * The two parts share the frame and differ in one panel:
 *
 *  - **The exposé keeps « Votre plan ».** Four beats, the same list the
 *    préparation rail gives thirty minutes to absorb, still on screen while the
 *    clock runs.
 *  - **The débat prints the exchange instead (#48).** A plan is a script for a
 *    monologue; during the débat the candidate is answering objections, and being
 *    able to re-read the one they are answering is worth more than the fidelity
 *    of not seeing it. « Masquer » still puts the reference's behaviour one click
 *    away, and hiding it falls back to the status card.
 *
 * **Nothing runs until « Enregistrer ».** The part opens armed: the consigne is
 * given, the sujet and the plan are readable, the timer shows the part's full
 * length and no artefact is open. The candidate starts it themselves. Reading the
 * document you are about to argue from should not be charged to the seven minutes
 * you have to argue in, and the DELF grades how long you spoke.
 */
export function PassationScreen({
  phase,
  topic,
  elapsed,
  remaining,
  recording,
  connected,
  connecting,
  canAdvance,
  awaitingStart,
  notes,
  notesOpen,
  onToggleNotes,
  transcript,
  transcriptOpen,
  onToggleTranscript,
  onStart,
  onAdvance,
  onExit,
  emptyTranscript = false,
  onRetryTranscription,
  awaitingConsigne = false,
  notices,
  announcement,
  devPanel,
}: {
  phase: SpeakingPhase;
  /** The sujet, on screen throughout. The reason this screen exists. */
  topic: OralTopic;
  elapsed: number;
  remaining: number;
  recording: boolean;
  connected: boolean;
  connecting: boolean;
  canAdvance: boolean;
  /** The part is armed and waiting for « Enregistrer ». */
  awaitingStart: boolean;
  notes: string;
  notesOpen: boolean;
  onToggleNotes: () => void;
  /** The whole exam transcript. Only the débat's half of it is ever shown here. */
  transcript: readonly TranscriptEntry[];
  /** Open by default, and only consulted during the débat. */
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
  /** « Enregistrer » — starts the clock, the recording and the session. */
  onStart: () => void;
  onAdvance: () => void;
  onExit: () => void;
  /** The monologue was ended with no speech recorded — the advance was refused. */
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
  /** The consigne is still being given, so nothing has started yet (#37). */
  awaitingConsigne?: boolean;
  /** Controller failures — a lost connection, a dead microphone. */
  notices?: ReactNode;
  /** The examiner's spoken consigne for this part (#37). */
  announcement?: ReactNode;
  /** Development-only diagnostics. Never rendered in production. */
  devPanel?: ReactNode;
}) {
  const total = phaseDurationSeconds(phase);
  const status = passationStatus(phase, connected, awaitingConsigne || awaitingStart);
  const hasNotes = notes.trim().length > 0;
  const partTitle = phase === "monologue" ? MONOLOGUE_TITLE : DEBATE_TITLE;
  const showTranscript = phase === "debate" && transcriptOpen;

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* The full part title, not the short label. There is room for it here —
          the stepper names the parts now, so the kicker no longer has to. */}
      <SimulatorTopBar
        kicker={poKicker(partTitle)}
        currentStep={topbarStep(phase, true)}
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

      <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-[47.5rem] flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6">
          {notices}

          {/* The sujet, on the paper stock the préparation screen prints it on,
              so the candidate recognises the same document rather than reading
              what looks like a different one. */}
          <section className="border-paper-border bg-paper rounded-lg border px-5 py-6 sm:px-7">
            <Kicker>{partieKicker(phase)}</Kicker>
            <h1 className="font-serif mt-1.5 text-[1.375rem] leading-[1.25] font-semibold text-balance">
              {topic.title}
            </h1>

            {announcement && <div className="mt-4">{announcement}</div>}

            <p className="document-text mt-4">{topic.document}</p>
          </section>

          {showTranscript ? (
            <DebateTranscript
              transcript={transcript}
              hint={status.body}
              onHide={onToggleTranscript}
            />
          ) : phase === "monologue" ? (
            <ExposePlan />
          ) : (
            <div className="border-border bg-card rounded-lg border border-dashed p-6 text-center">
              <h2 className="text-[0.84375rem] font-semibold">{status.title}</h2>
              <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-xs leading-relaxed">
                {status.body}
              </p>
              {/* The way back to the feed, on the card that replaced it. */}
              <button
                type="button"
                onClick={onToggleTranscript}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted mt-3.5 rounded-md border px-3 py-1.5 text-[0.6875rem] font-semibold transition-colors"
              >
                {DEBATE_TRANSCRIPT_COPY.show}
              </button>
            </div>
          )}

          {/* The exposé's status line lives under the plan rather than replacing
              it: the plan is the thing to be looking at, and this is one
              sentence saying whether the examiner is there yet. */}
          {phase === "monologue" && !awaitingStart && !awaitingConsigne && (
            <p className="text-muted-foreground text-center text-xs leading-relaxed">
              {status.body}
            </p>
          )}
        </div>

        <ConversationControls
          phase={phase}
          canAdvance={canAdvance}
          connecting={connecting}
          recording={recording}
          awaitingStart={awaitingStart}
          startDisabled={awaitingConsigne}
          elapsed={elapsed}
          hasNotes={hasNotes}
          notesOpen={notesOpen}
          onToggleNotes={onToggleNotes}
          onStart={onStart}
          onAdvance={onAdvance}
          emptyTranscript={emptyTranscript}
          onRetryTranscription={onRetryTranscription}
          devPanel={devPanel}
        />

        <footer className="border-border bg-card text-muted-foreground shrink-0 border-t px-4 py-2 text-center text-[0.6875rem]">
          {SITE_FOOTER}
        </footer>

        {hasNotes && (
          <NotesDrawer open={notesOpen} notes={notes} onClose={onToggleNotes} />
        )}
      </main>
    </div>
  );
}
