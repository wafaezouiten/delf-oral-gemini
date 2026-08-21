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
 *
 * **This is the one screen that asks for the archive** (#69). A candidate who
 * starts over takes their épreuves off the tableau de bord and off the sujet
 * cards; what they do not do is destroy them, and this page is where that
 * promise is kept. So it reads the record and the archive in one query — one
 * newest-first ordering rather than two that could disagree — and splits them
 * under a divider on the flag the rows carry.
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
  const history = await readCandidateHistory(userId, { includeArchived: true });

  // The split, on the flag rather than on a second query. `record` is what every
  // other screen in the product is looking at; `archived` is what only this one
  // still shows.
  const record = history.filter((sitting) => sitting.archivedAt === null);
  const archived = history.filter((sitting) => sitting.archivedAt !== null);

  const abandoned = record.filter((sitting) => sitting.outcome === "abandoned").length;

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

  // `max-w-4xl`, the tableau de bord's measure: the two screens print the same
  // `SittingRow`s, and this one was the hub's narrowest page — beside the rail
  // on a wide monitor it read as half a page of margin (#114). The empty state
  // above keeps `max-w-3xl`, like the dashboard's.
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <Kicker>DELF B2 · Production orale</Kicker>
      <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold">Historique</h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        {/* The count is the current record's, not the whole table's: it is the
            same number the tableau de bord computes its figures from, and two
            screens disagreeing about how many épreuves somebody has sat is
            exactly what a reset must not cause. The archive counts itself,
            below. */}
        {record.length} épreuve{record.length > 1 ? "s" : ""} à votre actif
        {abandoned > 0 && (
          <>
            , dont {abandoned} abandonnée{abandoned > 1 ? "s" : ""} et comptée
            {abandoned > 1 ? "s" : ""} 0/{COMPETENCY_MAX}
          </>
        )}
        . Une épreuve en cours n&apos;y figure pas.
      </p>

      {record.length > 0 ? (
        <section className="border-border bg-card mt-6 sheet border">
          <ul className="divide-border divide-y">
            {record.map((sitting) => (
              <SittingRow key={sitting.examId} sitting={sitting} detailed />
            ))}
          </ul>
        </section>
      ) : (
        /* Reachable only after a reset: the page-level empty state above needs
           the whole table to be empty, and it is not. Saying "aucune épreuve"
           here would contradict the archive sitting directly underneath. */
        <p className="border-border bg-card mt-6 sheet border px-6 py-5 text-sm leading-relaxed">
          Vous êtes reparti de zéro. Vos épreuves précédentes sont dans les
          archives, ci-dessous.{" "}
          <Link href={HUB_LINKS.sujets} className="font-semibold underline">
            Choisir un sujet
          </Link>
          .
        </p>
      )}

      {archived.length > 0 && (
        /* Below the record, under its own heading, and in the same rows: an
           archived épreuve is not a lesser one, it simply no longer counts. Its
           correction opens exactly as it always did, which is the whole promise
           « Repartir de zéro » makes. */
        <section className="mt-10">
          <h2 className="font-serif text-lg font-semibold">Archives</h2>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            {archived.length} épreuve{archived.length > 1 ? "s" : ""} d&apos;avant votre
            réinitialisation. Elle{archived.length > 1 ? "s" : ""} ne compte
            {archived.length > 1 ? "nt" : ""} plus dans vos statistiques, et
            {archived.length > 1 ? " leurs corrections restent" : " sa correction reste"}{" "}
            consultable{archived.length > 1 ? "s" : ""}.
          </p>
          {/* No dimming. The obvious way to show "this no longer counts" is to
              fade the block, and it would take the contrast of every score in it
              down with it — for a distinction the heading and the sentence above
              already make in words. */}
          <div className="border-border bg-card mt-4 sheet border">
            <ul className="divide-border divide-y">
              {archived.map((sitting) => (
                <SittingRow key={sitting.examId} sitting={sitting} detailed />
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
