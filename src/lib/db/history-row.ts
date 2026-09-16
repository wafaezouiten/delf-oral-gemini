import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import {
  zeroCriteria,
  type DashboardSitting,
  type SittingRecording,
} from "@/lib/ui/dashboard-view";

/**
 * One row of `readCandidateHistory`'s query, and what the view model makes of
 * it. Apart from `history.ts` so `node --test` can reach the reading without
 * a database behind it (#234): the query is one statement, the reading is
 * where the decisions are — what a walk-out scores, which stamp is the end,
 * which order the halves go in.
 */
export interface HistoryRow {
  examId: number;
  topicSlug: string;
  topicTitle: string;
  phase: string;
  finishedAt: Date | null;
  abandonedAt: Date | null;
  archivedAt: Date | null;
  score25: number | null;
  meetsFloor: boolean | null;
  mode: "text" | "audio" | null;
  spokenSeconds: number | string | null;
  recordings: SittingRecording[] | null;
  realisationTache: number | null;
  interaction: number | null;
  lexique: number | null;
  morphosyntaxe: number | null;
  phonologie: number | null;
}

/** The five band columns, read back into the shape the view model wants. */
function criteriaOf(row: HistoryRow): Record<OralCriterion, number> {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, Number(row[criterion] ?? 0)]),
  ) as Record<OralCriterion, number>;
}

/** The parts in the order they were sat — `json_agg` has no opinion about it. */
const PHASE_ORDER: ReadonlyArray<SittingRecording["phase"]> = ["monologue", "debate"];

export function sittingFromRow(row: HistoryRow): DashboardSitting {
  const abandoned = row.abandonedAt !== null;
  return {
    examId: row.examId,
    topicSlug: row.topicSlug,
    topicTitle: row.topicTitle,
    outcome: abandoned ? "abandoned" : "corrected",
    // The zero is the consequence of walking out, not a grading of it. See
    // `DashboardSitting` for why it is not an evaluation row.
    score25: abandoned ? 0 : (row.score25 ?? 0),
    meetsFloor: abandoned ? false : (row.meetsFloor ?? false),
    mode: abandoned ? null : row.mode,
    criteria: abandoned ? zeroCriteria() : criteriaOf(row),
    spokenSeconds: Number(row.spokenSeconds ?? 0),
    phase: row.phase,
    // Non-null by the query's WHERE clause: a row is there because it carries
    // one stamp or the other. The epoch is the fallback rather than a cast, so
    // a row that somehow had neither sorts first instead of throwing on a page
    // that is only reporting history.
    endedAt: row.abandonedAt ?? row.finishedAt ?? new Date(0),
    // Always read, even when the query filtered the archive out — the flag is
    // what lets the historique partition one list instead of running a second
    // query whose ordering could disagree with this one.
    archivedAt: row.archivedAt,
    // Null when the sitting has no `oral_recordings` rows at all, which the
    // left join reports as an absent group rather than an empty one. Sorted
    // into the order the halves were sat: `json_agg` returns them in whatever
    // order the scan produced, and a « Débat » player above a « Monologue
    // suivi » one is a record of the épreuve in the wrong order.
    recordings: [...(row.recordings ?? [])].sort(
      (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
    ),
  };
}
