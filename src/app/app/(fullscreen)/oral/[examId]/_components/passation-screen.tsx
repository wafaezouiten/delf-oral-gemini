"use client";

import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { cn } from "@/lib/ui/class-names";
import { phaseDurationSeconds } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import {
  MONOLOGUE_TITLE,
  DEBATE_TITLE,
  SITE_FOOTER,
  candidateStatus,
  examinerStatus,
  partieKicker,
  passationStatus,
  poKicker,
  topbarStep,
  type SpeakingPhase,
} from "@/lib/ui/po-player-view";
import { ConversationControls } from "./conversation-controls";
import { ConversationScene } from "./conversation-scene";
import { ExposePlan } from "./expose-plan";
import { NotesDrawer } from "./notes-drawer";

/**
 * The passation: the sujet the candidate is speaking about, in front of them
 * while they speak about it.
 *
 * **The sujet is on screen throughout, and that is what changed in #37.** This
 * screen was two avatar faces over a status card, with the document left behind
 * on the préparation: a candidate delivering a seven-minute argued exposé about
 * a text could not see the text, and could not see the plan they had been told
 * to follow. The sujet, the plan and the record control took that room and keep
 * it.
 *
 * The two parts share the frame and differ in what stands with the sujet:
 *
 *  - **The exposé sets « Votre plan » beside it, in a second column (#59).**
 *    Four beats, the same list the préparation rail gives thirty minutes to
 *    absorb, still on screen while the clock runs — and no longer under the
 *    document, where re-reading the source scrolled the plan away during the
 *    one part whose whole task is following it. The frame widens to hold both,
 *    and collapses to one column below `lg`.
 *  - **The débat shows the two protagonists, and not a word of what they say
 *    (#60).** It printed the exchange as it was transcribed (#48), on the
 *    argument that re-reading the objection you are answering beats the fidelity
 *    of not seeing it. The cost #48 named is the one being taken seriously now:
 *    reading your own words as you say them is the fastest way to stop listening
 *    to the examiner, and a débat is graded on interaction. So the faces are
 *    back — a ring around whoever holds the floor, one status line each — and
 *    the exchange is printed afterwards, on the results page, where reading it
 *    is the task rather than a distraction from one.
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
  examinerSpeaking,
  connected,
  connecting,
  canAdvance,
  awaitingStart,
  closing,
  notes,
  notesOpen,
  onToggleNotes,
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
  /**
   * The examiner holds the floor: their voice is streaming, or a consigne is
   * playing (`ExamController` counts both). The débat's scene reads it, and it is
   * the only thing on that screen that says whose turn it is (#60).
   */
  examinerSpeaking: boolean;
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

              {/* The débat's panel: who is speaking, and nothing they said
                  (#60). It replaces the live transcript and the quiet card the
                  transcript could be hidden behind — the two lines the card
                  carried are the two under the faces, so the card was saying
                  them a second time. */}
              <ConversationScene
                examinerSpeaking={examinerSpeaking}
                examinerStatus={examinerStatus({
                  connected,
                  connecting,
                  speaking: examinerSpeaking,
                  announcing: awaitingConsigne,
                  closing,
                })}
                // Not simply `recording`: the microphone stays open while the
                // examiner interrupts, and two rings pulsing at once says the
                // one thing this screen exists to answer is "both of you".
                candidateRecording={recording && !examinerSpeaking}
                candidateStatus={candidateStatus({
                  connected,
                  examinerSpeaking,
                  recording,
                })}
                candidateStatusUrgent={remaining <= 60}
                elapsed={elapsed}
                total={total}
              />
            </>
          )}

          {/* One sentence of guidance, under the panel rather than replacing it:
              the plan (exposé) and the scene (débat) are the things to be
              looking at, and this says whether the examiner is there yet and
              what the part asks for. */}
          {!awaitingStart && !awaitingConsigne && (
            // A live region in the exposé, and permanently one: it carries the
            // examiner's arrival and — since #55 — the close, and a region that
            // only gets its role at the moment its text changes is a region a
            // screen reader has no reason to have been watching. Its handful of
            // states are all events worth hearing, unlike the countdown under
            // the control below.
            //
            // Not in the débat, where the scene above is already announcing
            // every turn change politely and says the same arrival and the same
            // close in the examiner's own status line (#60). Two regions
            // reporting one event is how a screen reader user hears it twice.
            <p
              role={phase === "monologue" ? "status" : undefined}
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
