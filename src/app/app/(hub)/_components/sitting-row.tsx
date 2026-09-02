import Link from "next/link";

import { RecordingPlayer } from "@/app/_components/recording-player";
import { ChevronDownIcon } from "@/app/_components/po/icons";
import { Tag } from "@/app/_components/po/tag";
import { ScoreTag } from "@/app/_components/score-band";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { formatClock } from "@/lib/delf/phases";
import { PHASE_HEADINGS } from "@/lib/ui/correction-transcript";
import { formatScore25 } from "@/lib/ui/format-score";
import {
  describeOutcome,
  formatSittingDate,
  formatSittingDateTime,
  type DashboardSitting,
} from "@/lib/ui/dashboard-view";

/**
 * One sitting on the candidate's record, shared by the tableau de bord's short
 * list and the historique's full one.
 *
 * The two differ only in how much they say — `detailed` turns on the fuller
 * timestamp, the speaking time and the sentence describing what happened — so
 * they are one component rather than two that drift. A score printed one way on
 * the dashboard and another in the history is the kind of difference nobody
 * notices until a candidate asks which one is right.
 *
 * **The recordings are back on the historique, folded away (#185).** #98 put two
 * players on every corrected row and #116 took them off again, for a reason that
 * still holds: a full transport card per half turns a list of scores into a
 * mixing desk. What #116 got wrong was the conclusion — the affordance is not
 * the only thing a candidate wants there, and « open the correction, scroll,
 * come back » is three steps to hear thirty seconds of your own French.
 *
 * So the players are here and closed. A native `<details>` carries them: the row
 * is one reading-height tall until somebody asks, it needs no client state on a
 * server-rendered list, and it opens with the keyboard because a `<summary>`
 * already does. The list scans; the audio is one press away.
 *
 * **Only on the historique** (`detailed`). The tableau de bord's five-row list
 * is evidence for the figures above it, not a place to listen back — and it is
 * the screen #116's "mixing desk" complaint was actually about.
 *
 * The row offers exactly what the correction offers, because both read the same
 * test for a kept recording (a uri, no purge stamp). A row advertising audio the
 * correction then refuses would be worse than no row at all.
 *
 * An abandoned sitting has no correction to open, so it is not a link. That is
 * deliberate and not an oversight: a `/app/results/:id` for a walk-out would
 * render the "Résultat introuvable" card, which reads as a bug rather than as
 * the truth that there is nothing to show.
 */
export function SittingRow({
  sitting,
  detailed = false,
}: {
  sitting: DashboardSitting;
  detailed?: boolean;
}) {
  const abandoned = sitting.outcome === "abandoned";
  // A walk-out has nothing to play even when a phase row exists for it, and the
  // dashboard's short list does not offer playback at all.
  const playable = detailed && !abandoned ? sitting.recordings : [];

  return (
    <li className="px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          {abandoned ? (
            <p className="text-muted-foreground truncate text-sm font-medium">
              {sitting.topicTitle}
            </p>
          ) : (
            <Link
              href={`/app/results/${sitting.examId}`}
              className="block truncate text-sm font-medium hover:underline"
            >
              {sitting.topicTitle}
            </Link>
          )}

          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {detailed ? formatSittingDateTime(sitting.endedAt) : formatSittingDate(sitting.endedAt)}
            {detailed && (
              <>
                {" · "}
                {describeOutcome(sitting)}
                {/* Only where there is any: a walk-out during the préparation
                  recorded nothing, and "0:00 de parole" beside it would read as
                  a microphone failure rather than as a decision. */}
                {sitting.spokenSeconds > 0 && ` · ${formatClock(sitting.spokenSeconds)} de parole`}
              </>
            )}
            {!detailed && sitting.mode === "text" && " · corrigée sans l'audio"}
            {!detailed && abandoned && " · abandonnée"}
          </p>
        </div>

        {/* The mark and the word, never the tint alone: an abandoned zero and a
          failed correction are both red, and only one of them is about the
          candidate's French.

          Which is why the abandonment keeps its own pill rather than joining the
          /25 scale. A walk-out scores 0/25 as a consequence, not as a grading, so
          it is not painted on the scale that grades one. It stays the em dash,
          and the line above says the word. */}
        {abandoned ? (
          <Tag tone="danger">
            <span aria-hidden>—</span>
            {formatScore25(sitting.score25)}/{COMPETENCY_MAX}
          </Tag>
        ) : (
          <ScoreTag score25={sitting.score25} mark={sitting.meetsFloor ? "✓" : "✕"} />
        )}
      </div>

      {/* Closed until asked for. `group` + `open:` is the whole mechanism — no
          state, no effect, and it survives this component staying a server one.
          `no-print` like every player: a printed record is a list of marks. */}
      {playable.length > 0 && (
        <details className="no-print group mt-2">
          <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold transition-colors [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
            Réécouter
          </summary>
          <div className="mt-2 flex flex-col gap-2.5">
            {playable.map((recording) => (
              <div key={recording.phase}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-semibold">{PHASE_HEADINGS[recording.phase]}</p>
                  <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem]">
                    {formatClock(recording.durationSeconds)}
                  </span>
                </div>
                <RecordingPlayer
                  src={`/api/exams/${sitting.examId}/recordings/${recording.phase}`}
                  mimeType={recording.mimeType}
                  durationSeconds={recording.durationSeconds}
                  className="mt-1.5"
                />
              </div>
            ))}
          </div>
        </details>
      )}
    </li>
  );
}
