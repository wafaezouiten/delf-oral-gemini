import { currentUser } from "@clerk/nextjs/server";

import { requireUserId } from "@/lib/auth/exam-guard";
import { readCandidateHistory } from "@/lib/db/history";
import { ORAL_TOPICS } from "@/lib/delf/topics";
import {
  buildFeaturedSujets,
  buildHubView,
  HUB_LINKS,
  hubGreeting,
  latestScoreBySujet,
} from "@/lib/ui/epreuve-hub";
import { HubCapabilities, HubFormat, HubMasthead, HubSujets } from "./_components/hub-sections";

/**
 * The Production orale hub.
 *
 * PORT NOTE: the reference's `/production-orale` — `EpreuveHub` rendered from a
 * pure view model, with the data-fetching kept here rather than in the
 * components. Everything it prints about the épreuve comes out of `buildHubView`
 * and therefore out of `constants.ts`; the only thing this page fetches is the
 * candidate's own standing, which is what turns "Commencer" into "Refaire".
 *
 * `force-dynamic` for the same reason the reference marks its hub dynamic: the
 * sujet cards carry a per-user score, so a cached render would show one
 * candidate's history to the next.
 *
 * The hub describes the épreuve; it is not a progress screen. The reference cut
 * a standing band and a walkthrough from this page and recorded why — the
 * standing belongs to the tableau de bord, one click away in the masthead, and a
 * walkthrough restated the format section with worse numbers. Neither is
 * reproduced.
 */

export const dynamic = "force-dynamic";

export default async function ProductionOraleHub() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  const userId = await requireUserId();

  const [user, history] = await Promise.all([currentUser(), readCandidateHistory(userId)]);

  const view = buildHubView();
  // The first three of the catalogue (#188), not the whole of it: the kiosk is
  // one click away for the rest.
  const sujets = buildFeaturedSujets(ORAL_TOPICS, latestScoreBySujet(history));
  const greeting = hubGreeting(user?.firstName, history.length);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <HubMasthead view={view} />

      {greeting && <p className="text-muted-foreground mt-4 text-sm">{greeting}</p>}

      <HubFormat view={view} />
      <HubSujets sujets={sujets} allSujetsHref={HUB_LINKS.sujets} />
      <HubCapabilities view={view} />
    </main>
  );
}
