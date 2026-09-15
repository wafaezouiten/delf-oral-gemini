import { COMPETENCY_MAX } from "@/lib/delf/constants";
import type { DashboardSitting } from "@/lib/ui/dashboard-view";

export interface HistoriqueView {
  /** Nothing on the record and nothing in the archive: the page's empty state. */
  empty: boolean;
  /** What every other screen in the product is looking at. */
  record: DashboardSitting[];
  /** What only the historique still shows (#69). */
  archived: DashboardSitting[];
  /** « 3 épreuves à votre actif, dont 1 abandonnée et comptée 0/25. … » */
  summary: string;
  /** The archive's own count and what it means — null when there is none. */
  archiveNote: string | null;
}

/**
 * The historique, as a view model (#234): the record and the archive split on
 * the flag the rows carry rather than on a second query, and the two sentences
 * that count them.
 *
 * The summary counts the current record, not the whole table: it is the same
 * number the tableau de bord computes its figures from, and two screens
 * disagreeing about how many épreuves somebody has sat is exactly what a reset
 * must not cause. The archive counts itself.
 */
export function historiqueView(history: readonly DashboardSitting[]): HistoriqueView {
  const record = history.filter((sitting) => sitting.archivedAt === null);
  const archived = history.filter((sitting) => sitting.archivedAt !== null);
  return {
    empty: history.length === 0,
    record,
    archived,
    summary: recordSummary(record),
    archiveNote: archived.length > 0 ? archiveNote(archived.length) : null,
  };
}

function recordSummary(record: readonly DashboardSitting[]): string {
  const abandoned = record.filter((sitting) => sitting.outcome === "abandoned").length;
  const s = (count: number) => (count > 1 ? "s" : "");
  const walkOuts =
    abandoned > 0
      ? `, dont ${abandoned} abandonnée${s(abandoned)} et comptée${s(abandoned)} 0/${COMPETENCY_MAX}`
      : "";
  return `${record.length} épreuve${s(record.length)} à votre actif${walkOuts}. Une épreuve en cours n'y figure pas.`;
}

function archiveNote(count: number): string {
  if (count === 1) {
    return "1 épreuve d'avant votre réinitialisation. Elle ne compte plus dans vos statistiques, et sa correction reste consultable.";
  }
  return `${count} épreuves d'avant votre réinitialisation. Elles ne comptent plus dans vos statistiques, et leurs corrections restent consultables.`;
}
