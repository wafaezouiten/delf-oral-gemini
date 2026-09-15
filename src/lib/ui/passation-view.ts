import { phaseDurationSeconds } from "@/lib/delf/phases";

import {
  DEBATE_TITLE,
  MONOLOGUE_TITLE,
  candidateStatus,
  examinerStatus,
  passationStatus,
  type SpeakingPhase,
} from "./po-player-view";

/**
 * Everything the passation screen decides, decided here (#234): what the
 * part is called, how the column is set, what the scene says about each
 * face, and whether the one-line status prints under the plan. The words
 * themselves are `po-player-view.ts`'s; this is the composition the screen
 * used to do inline.
 */

/** How many seconds are left before the candidate's status is said urgently. */
export const URGENT_REMAINING_SECONDS = 60;

export interface PassationInput {
  phase: SpeakingPhase;
  remaining: number;
  recording: boolean;
  examinerSpeaking: boolean;
  openingQuestionPending: boolean;
  connected: boolean;
  connecting: boolean;
  awaitingStart: boolean;
  closing: boolean;
  awaitingConsigne: boolean;
  notes: string;
}

export interface SceneView {
  examinerSpeaking: boolean;
  examinerStatus: string;
  candidateRecording: boolean;
  candidateStatus: string;
  candidateStatusUrgent: boolean;
}

export interface PassationView {
  total: number;
  partTitle: string;
  layout: "monologue" | "debate";
  /** The empty conversation's hint, and the monologue's one-line status. */
  statusBody: string;
  /** Under the plan, one sentence saying whether the examiner is there yet —
   *  only once the part has started and the consigne has been heard. The
   *  débat's conversation prints the same sentence while it is empty. */
  statusLine: string | null;
  hasNotes: boolean;
  /** Where the consigne is still playing, « Commencer » waits for it. */
  startDisabled: boolean;
  scene: SceneView;
}

export function passationView(input: PassationInput): PassationView {
  const { phase } = input;
  const status = passationStatus(
    phase,
    input.connected,
    input.awaitingConsigne || input.awaitingStart,
    input.closing,
  );
  // The opening question counts as the examiner speaking for every face and
  // status: the microphone is held while it is owed (#94), and a candidate
  // told « Vous avez la parole » a beat before the question lands would talk
  // over it.
  const examinerHasTheFloor = input.examinerSpeaking || input.openingQuestionPending;

  return {
    total: phaseDurationSeconds(phase),
    partTitle: phase === "monologue" ? MONOLOGUE_TITLE : DEBATE_TITLE,
    layout: phase,
    statusBody: status.body,
    statusLine:
      phase === "monologue" && !input.awaitingStart && !input.awaitingConsigne ? status.body : null,
    hasNotes: input.notes.trim().length > 0,
    startDisabled: input.awaitingConsigne,
    scene: {
      examinerSpeaking: examinerHasTheFloor,
      examinerStatus: examinerStatus({
        connected: input.connected,
        connecting: input.connecting,
        speaking: input.examinerSpeaking,
        announcing: input.awaitingConsigne,
        closing: input.closing,
        opening: input.openingQuestionPending,
      }),
      candidateRecording: input.recording && !examinerHasTheFloor,
      candidateStatus: candidateStatus({
        connected: input.connected,
        examinerSpeaking: examinerHasTheFloor,
        recording: input.recording,
      }),
      candidateStatusUrgent: input.remaining <= URGENT_REMAINING_SECONDS,
    },
  };
}
