import type { Metadata } from "next";
import Link from "next/link";

import { primaryButton } from "@/app/_components/button-styles";
import { ClockIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { requireUserId } from "@/lib/auth/exam-guard";
import { readCandidateHistory } from "@/lib/db/history";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import { SittingRow } from "../_components/sitting-row";

/**
 * The historique: every épreuve on the candidate's record, newest first.
 *
 * The tableau de bord answers "how am I doing?" and shows the five most recent
 * sittings as evidence for its figures. This page answers "what have I done?"
 * and shows all of them — so it is a list and nothing else: no tiles, no chart,
 * no averages. Two pages that both open on a row of statistics would be the same
 * page twice.
 *
 * It prints both kinds of sitting, and prints them differently. A corrected one
 * links to its correction; an abandoned one names the phase it was walked out of
 * and does not link anywhere, because a `/app/results/:id` with no evaluation
 * behind it renders "Résultat introuvable" — which reads as a bug rather than as
 * the truth that there is nothing to show.
 *
 * The rows themselves are `SittingRow`, shared with the dashboard, so a score
 * cannot be printed one way here and another way there.
 */

export const metadata: Metadata = {
  title: "Historique · Production orale DELF B2",
  description:
    "Toutes vos épreuves de production orale DELF B2 : notes sur 25, corrections et abandons.",
};

// Per-user, so a cached render would show one candidate's record to the next.
export const dynamic = "force-dynamic";

export default async function HistoriquePage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  const userId = await requireUserId();
  const history = await readCandidateHistory(userId);

  const abandoned = history.filter((sitting) => sitting.outcome === "abandoned").length;

  if (history.length === 0) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
        <span className="bg-primary-subtle text-primary mx-auto flex size-14 items-center justify-center rounded-lg">
          <ClockIcon className="size-7" />
        </span>
        <h1 className="font-serif mt-5 text-2xl font-semibold">Aucune épreuve passée</h1>
        <p className="text-muted-foreground mx-auto mt-3 max-w-[48ch] text-sm leading-relaxed">
          Vos épreuves apparaîtront ici dès la première, avec leur note sur{" "}
          {COMPETENCY_MAX} et le détail de la correction. Une épreuve abandonnée y
          figure aussi, comptée comme une tentative notée 0.
        </p>
        <div className="mt-7">
          <Link href={HUB_LINKS.sujets} className={primaryButton}>
            Choisir un sujet
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Kicker>DELF B2 · Production orale</Kicker>
      <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold">Historique</h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        {history.length} épreuve{history.length > 1 ? "s" : ""} à votre actif
        {abandoned > 0 && (
          <>
            , dont {abandoned} abandonnée{abandoned > 1 ? "s" : ""} et comptée
            {abandoned > 1 ? "s" : ""} 0/{COMPETENCY_MAX}
          </>
        )}
        . Une épreuve en cours n&apos;y figure pas.
      </p>

      <section className="border-border bg-card mt-6 sheet border">
        <ul className="divide-border divide-y">
          {history.map((sitting) => (
            <SittingRow key={sitting.examId} sitting={sitting} detailed />
          ))}
        </ul>
      </section>
    </main>
  );
}
