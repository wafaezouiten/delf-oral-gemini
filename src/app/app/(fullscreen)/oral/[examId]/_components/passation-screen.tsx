"use client";

import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { phaseDurationSeconds } from "@/lib/delf/phases";
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
 * **There is no transcript feed, and that is the reference's design decision
 * reproduced rather than a regression.** The exchange is spoken, not printed: a
 * candidate reading their own words as they say them is doing something the
 * épreuve never asks of them, and watching a transcript arrive is the fastest
 * way to stop listening to the examiner. What is on screen instead is one quiet
 * card saying where they are.
 *
 * That has a second, sharper justification here than in the reference. Verified
 * against the live service: during a monologue nothing is transcribed until the
 * floor is released, so the whole exposé arrives at once at the end — a
 * transcript panel would sit empty for seven minutes and look broken. The old
 * screen said so in a paragraph; this one does not need to, because it never
 * promises a feed.
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
  onAdvance,
  onExit,
  emptyTranscript = false,
  onRetryTranscription,
  badges,
  notices,
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
  onAdvance: () => void;
  onExit: () => void;
  /** The monologue was ended with no speech recorded — the advance was refused. */
  emptyTranscript?: boolean;
  onRetryTranscription?: () => void;
  /** The recording and connection badges. See the strip below for why not the chrome. */
  badges: ReactNode;
  /** Controller failures — a lost connection, a dead microphone. */
  notices?: ReactNode;
  /** Development-only diagnostics. Never rendered in production. */
  devPanel?: ReactNode;
}) {
  const total = phaseDurationSeconds(phase);
  const status = passationStatus(phase, connected);
  const hasNotes = notes.trim().length > 0;
  const partTitle = phase === "monologue" ? MONOLOGUE_TITLE : DEBATE_TITLE;

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

          <div className="border-border bg-card rounded-lg border border-dashed p-6 text-center">
            <h2 className="text-[0.84375rem] font-semibold">{status.title}</h2>
            <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-xs leading-relaxed">
              {status.body}
            </p>
          </div>
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
