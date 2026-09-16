import { formatClock } from "@/lib/delf/phases";
import { PHASE_HEADINGS } from "@/lib/ui/correction-transcript";
import {
  describeOutcome,
  formatSittingDate,
  formatSittingDateTime,
  type DashboardSitting,
  type SittingRecording,
} from "@/lib/ui/dashboard-view";

/** One half's player on the historique (#185): its heading, its clock, its bytes. */
export interface SittingPlayer {
  phase: SittingRecording["phase"];
  heading: string;
  duration: string;
  src: string;
  mimeType: string;
  durationSeconds: number;
}

export interface SittingRowView {
  /** The correction to open, or null for a walk-out, which has none (see the row's doc). */
  href: string | null;
  abandoned: boolean;
  /** The pill's mark: the seuil met or not. Meaningless on a walk-out, which wears the em dash. */
  mark: "✓" | "✕";
  /** The line under the title: the stamp, and on the historique what happened. */
  stamp: string;
  /** The players the row folds away — only on the historique, never for a walk-out. */
  players: SittingPlayer[];
}

/**
 * What one row of the record prints (#234).
 *
 * The two lists differ only in how much they say: `detailed` (the historique)
 * turns on the fuller timestamp, the sentence describing what happened and the
 * speaking time; the tableau de bord's short list keeps the date and a word.
 */
export function sittingRowView(sitting: DashboardSitting, detailed: boolean): SittingRowView {
  const abandoned = sitting.outcome === "abandoned";
  return {
    href: abandoned ? null : `/app/results/${sitting.examId}`,
    abandoned,
    mark: sitting.meetsFloor ? "✓" : "✕",
    stamp: detailed ? detailedStamp(sitting) : shortStamp(sitting, abandoned),
    // A walk-out has nothing to play even when a phase row exists for it, and
    // the dashboard's short list does not offer playback at all.
    players: detailed && !abandoned ? sitting.recordings.map(playerFor(sitting.examId)) : [],
  };
}

function detailedStamp(sitting: DashboardSitting): string {
  // The speaking time only where there is any: a walk-out during the
  // préparation recorded nothing, and "0:00 de parole" beside it would read as
  // a microphone failure rather than as a decision.
  const spoken =
    sitting.spokenSeconds > 0 ? ` · ${formatClock(sitting.spokenSeconds)} de parole` : "";
  return `${formatSittingDateTime(sitting.endedAt)} · ${describeOutcome(sitting)}${spoken}`;
}

function shortStamp(sitting: DashboardSitting, abandoned: boolean): string {
  const note = sitting.mode === "text" ? " · corrigée sans l'audio" : "";
  const walkOut = abandoned ? " · abandonnée" : "";
  return `${formatSittingDate(sitting.endedAt)}${note}${walkOut}`;
}

function playerFor(examId: number): (recording: SittingRecording) => SittingPlayer {
  return (recording) => ({
    phase: recording.phase,
    heading: PHASE_HEADINGS[recording.phase],
    duration: formatClock(recording.durationSeconds),
    src: `/api/exams/${examId}/recordings/${recording.phase}`,
    mimeType: recording.mimeType,
    durationSeconds: recording.durationSeconds,
  });
}
