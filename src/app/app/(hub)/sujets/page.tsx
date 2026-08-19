import type { Metadata } from "next";

import { requireUserId } from "@/lib/auth/exam-guard";
import { readCandidateHistory } from "@/lib/db/history";
import { ORAL_TOPICS } from "@/lib/delf/topics";
import { buildHubSujets, latestScoreBySujet } from "@/lib/ui/epreuve-hub";
import { SujetsCatalogue, type KioskSujet } from "./_components/sujets-catalogue";

/**
 * The sujets kiosk.
 *
 * PORT NOTE: the reference's `/production-orale/sujets-actualites`. Its route is
 * named for a catalogue that rotates monthly and is scraped from the press;
 * this one is the seeded `ORAL_TOPICS`, so the segment is `sujets` and there is
 * no `[month]` child — see the catalogue component for the rest of that
 * argument.
 *
 * A Server Component that transforms rows and hands them down, exactly as the
 * reference's `OraleSujetsListing` does: the filter state lives inside the
 * catalogue, which draws its own client boundary, so the view helpers never
 * reach the browser bundle.
 */

export const metadata: Metadata = {
  title: "Sujets · Production orale DELF B2",
  description:
    "Les sujets de production orale DELF B2 : document déclencheur, consigne officielle, examinateur IA et correction sur 25.",
};

// The cards carry a per-user score, so a cached render would show one
// candidate's history to the next.
export const dynamic = "force-dynamic";

export default async function SujetsPage({ searchParams }: PageProps<"/app/sujets">) {
  const userId = await requireUserId();

  const [history, query] = await Promise.all([readCandidateHistory(userId), searchParams]);
  const scores = latestScoreBySujet(history);

  // `buildHubSujets` owns the card's every string; the topic rides along so the
  // sheet can print the document without a second pass over the catalogue.
  //
  // Joined on the slug rather than on the index. `buildHubSujets` maps 1:1 today
  // so the two agree — but a card whose sheet prints a different sujet's
  // document is a failure nothing would catch, and the day it filters or sorts
  // is the day the indices stop lining up silently.
  const bySlug = new Map(ORAL_TOPICS.map((topic) => [topic.slug, topic]));
  const sujets: KioskSujet[] = buildHubSujets(ORAL_TOPICS, scores).flatMap((sujet) => {
    const topic = bySlug.get(sujet.slug);
    return topic ? [{ ...sujet, topic }] : [];
  });

  const requested = typeof query.sujet === "string" ? query.sujet : undefined;
  // Validated against the catalogue rather than passed through: a stale link
  // should open the grid, not a sheet with nothing in it.
  const initialSlug = sujets.some((sujet) => sujet.slug === requested) ? requested : undefined;

  return <SujetsCatalogue sujets={sujets} initialSlug={initialSlug} />;
}
