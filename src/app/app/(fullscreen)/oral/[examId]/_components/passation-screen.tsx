"use client";

import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { cn } from "@/lib/ui/class-names";
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
 * The two parts share the frame and differ in what stands with the sujet:
 *
 *  - **The exposé sets « Votre plan » beside it, in a second column (#59).**
 *    Four beats, the same list the préparation rail gives thirty minutes to
 *    absorb, still on screen while the clock runs — and no longer under the
 *    document, where re-reading the source scrolled the plan away during the
 *    one part whose whole task is following it. The frame widens to hold both,
 *    and collapses to one column below `lg`.
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
  closing,
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
  /**
   * The part has been ended and the examiner is giving its closing sentence
   * (#55). Several seconds, during which the candidate's own click was the last
   * thing that changed on this screen.
   */
  closing: boolean;
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
  /** « Passer », for as long as this part's spoken consigne lasts (#37, #59). */
  announcement?: ReactNode;
  /** Development-only diagnostics. Never rendered in production. */
  devPanel?: ReactNode;
}) {
  const total = phaseDurationSeconds(phase);
  const status = passationStatus(
    phase,
    connected,
    awaitingConsigne || awaitingStart,
    closing,
  );
  const hasNotes = notes.trim().length > 0;
  const partTitle = phase === "monologue" ? MONOLOGUE_TITLE : DEBATE_TITLE;
  const showTranscript = phase === "debate" && transcriptOpen;

  /**
   * The sujet, on the paper stock the préparation screen prints it on, so the
   * candidate recognises the same document rather than reading what looks like a
   * different one.
   *
   * Lifted out of the layout because the two parts frame it differently: the
   * exposé sets « Votre plan » beside it in a second column, the débat gives the
   * whole measure to the exchange.
   */
  const sujet = (
    <section className="border-paper-border bg-paper rounded-lg border px-5 py-6 sm:px-7">
      {/* « Passer » beside the title, not under it (#59): the consigne is
          twenty-five seconds of the examiner talking about this sujet, and a
          control that pushed the document down the page for the length of a
          sentence would move the thing being read. The held state wraps to its
          own line — it is a paragraph, not a word. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <Kicker>{partieKicker(phase)}</Kicker>
          <h1 className="font-serif mt-1.5 text-[1.375rem] leading-[1.25] font-semibold text-balance">
            {topic.title}
          </h1>
        </div>
        {announcement}
      </div>

      <p className="document-text mt-4">{topic.document}</p>
    </section>
  );

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* The full part title, not the short label. There is room for it here —
          the stepper names the parts now, so the kicker no longer has to. */}
      <SimulatorTopBar
        kicker={poKicker(partTitle)}
        currentStep={topbarStep(phase)}
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
        <div
          className={cn(
            "mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6",
            // The exposé carries two columns and needs the room for them; the
            // débat is one column of paper, and a document set in a wider
            // measure than this is harder to read, not easier.
            phase === "monologue" ? "max-w-[64rem]" : "max-w-[47.5rem]",
          )}
        >
          {notices}

          {phase === "monologue" ? (
            /* Sujet left, plan right. The four beats used to sit *under* the
               document, which meant a candidate who scrolled to re-read their
               source scrolled the plan off the screen — during the one part of
               the épreuve where following it is the whole task. Side by side,
               neither costs the other any height. Below `lg` the grid is one
               column and the plan falls back under the sujet, which is the only
               order that fits a phone. */
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
              {sujet}
              <ExposePlan />
            </div>
          ) : (
            <>
              {sujet}

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
            </>
          )}

          {/* The exposé's status line lives under the plan rather than replacing
              it: the plan is the thing to be looking at, and this is one
              sentence saying whether the examiner is there yet. */}
          {phase === "monologue" && !awaitingStart && !awaitingConsigne && (
            // A live region, and permanently one: it carries the examiner's
            // arrival and — since #55 — the close, and a region that only gets
            // its role at the moment its text changes is a region a screen
            // reader has no reason to have been watching. Its handful of states
            // are all events worth hearing, unlike the countdown under the
            // control below.
            <p
              role="status"
              className="text-muted-foreground text-center text-xs leading-relaxed"
            >
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
          closing={closing}
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
