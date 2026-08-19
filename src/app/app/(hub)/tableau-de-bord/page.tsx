import type { Metadata } from "next";

import { requireUserId } from "@/lib/auth/exam-guard";
import { readCandidateHistory } from "@/lib/db/history";
import { buildDashboardView } from "@/lib/ui/dashboard-view";
import { Dashboard } from "./_components/dashboard";

/**
 * The tableau de bord: fetch, shape, render.
 *
 * PORT NOTE: the reference's `/production-orale/tableau-de-bord`. Its route file
 * holds the query, the arithmetic and the JSX together; here the three are
 * separated — `readCandidateHistory` reads, `buildDashboardView` computes (and is
 * unit-tested), `<Dashboard>` draws. The arithmetic is somebody's standing, so
 * it should be checkable without a database.
 */

export const metadata: Metadata = {
  title: "Tableau de bord · Production orale DELF B2",
  description:
    "Votre progression à la production orale du DELF B2 : note moyenne sur 25, critères, temps de parole et historique.",
};

// Per-user figures: a cached render would show one candidate's standing to the
// next.
export const dynamic = "force-dynamic";

export default async function TableauDeBordPage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  const userId = await requireUserId();
  const history = await readCandidateHistory(userId);

  // `new Date()` here rather than inside the view model, so the streak's
  // arithmetic stays pure and testable without freezing a clock.
  return <Dashboard view={buildDashboardView(history, new Date())} />;
}
