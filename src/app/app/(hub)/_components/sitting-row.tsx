import Link from "next/link";

import { Tag } from "@/app/_components/po/tag";
import { ScoreTag } from "@/app/_components/score-band";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { formatClock } from "@/lib/delf/phases";
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
 * What neither shows is the kept recordings. #98 put two players on every
 * corrected historique row and #116 took them off again: a full transport card
 * per half turned a list of scores into a mixing desk, and the correction the
 * title links to already carries the same two players. The link is the
 * affordance; the row stays one reading-height tall.
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

  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 py-3.5">
      <div className="min-w-0 flex-1">
        {abandoned ? (
          <p className="text-muted-foreground truncate text-sm font-medium">{sitting.topicTitle}</p>
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
          {sitting.score25}/{COMPETENCY_MAX}
        </Tag>
      ) : (
        <ScoreTag score25={sitting.score25} mark={sitting.meetsFloor ? "✓" : "✕"} />
      )}
    </li>
  );
}
