"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ArrowRightIcon, ClockIcon, CloseIcon, SearchIcon } from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import { ScoreTag } from "@/app/_components/score-band";
import { StartExamButton } from "@/app/app/(hub)/_components/start-exam-button";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { HubSujet } from "@/lib/ui/epreuve-hub";

/**
 * The sujets kiosk: the catalogue and a sujet's full sheet, whose footer starts
 * the épreuve.
 *
 * PORT NOTE: the reference's `components/sujets/*` — `SujetsMasthead`,
 * `SujetCard` and `SujetDetailSheet` — reproduced as one client component. The
 * reference splits them across five files because the same kiosk serves the
 * écrite and the orale catalogues from a shared `SujetItem`; with one catalogue
 * there is nothing to share with, and the search state that forced its client
 * boundary is the only state here.
 *
 * Three of the reference's controls are deliberately NOT reproduced:
 *
 *  - **The facet chips.** It facets by DELF partie because its catalogue mixes
 *    A1–B2 parts and a candidate genuinely browses by "Monologue suivi" vs
 *    "Débat". Every sujet here is the same B2 épreuve — monologue *and* débat —
 *    so the toolbar would render a single chip reading the catalogue's own size,
 *    which is a filter that filters nothing.
 *  - **The `[month]` route.** Its sujets carry a publication month; these do not,
 *    and inventing one from the seed order would be a fabricated date on a page
 *    whose whole promise is that the sujets are current.
 *  - **`SujetLaunchDialog`** (#131). Its whole content — sujet, durée, « la
 *    préparation démarre dès l'ouverture » — restated what the sheet under it
 *    already showed, so the flow is card → sheet → « Passer l'épreuve », and the
 *    dialog's one load-bearing warning moved onto the sheet's footer.
 */

export interface KioskSujet extends HubSujet {
  topic: OralTopic;
}

export function SujetsCatalogue({
  sujets,
  /** A sujet to open on arrival — the hub's cards link straight to one. */
  initialSlug,
}: {
  sujets: readonly KioskSujet[];
  initialSlug?: string;
}) {
  const [query, setQuery] = useState("");
  const [openSlug, setOpenSlug] = useState<string | null>(initialSlug ?? null);
  const searchId = useId();

  const filtered = useMemo(() => {
    const needle = normalise(query);
    if (!needle) return sujets;
    return sujets.filter(
      (sujet) =>
        normalise(sujet.title).includes(needle) || normalise(sujet.topic.document).includes(needle),
    );
  }, [query, sujets]);

  const open = sujets.find((sujet) => sujet.slug === openSlug) ?? null;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
      <header className="pt-10 sm:pt-14">
        <h1 className="font-serif text-[2.125rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-[2.75rem]">
          Production orale · Sujets
        </h1>
        <p className="text-muted-foreground mt-3 text-[0.84375rem] leading-relaxed text-pretty">
          Des débats d&apos;actualité transformés en sujets d&apos;examen : le document déclencheur,
          la consigne officielle, puis un examinateur qui vous répond et vous note sur{" "}
          {COMPETENCY_MAX}.
        </p>

        {/* The facts, banded between two hairlines: a quiet strip that separates
            the title from the catalogue without a rule heavy enough to read as a
            divider dropped across the page. One line, always — on a narrow
            screen it scrolls sideways rather than breaking, because a phrase
            wrapped inside a banded strip reads as a layout fault. */}
        <div className="mt-7">
          <div className="bg-border h-px" />
          <div className="text-muted-foreground tabular flex [scrollbar-width:none] items-center gap-x-3 overflow-x-auto py-3 text-[0.6875rem] font-medium tracking-[0.04em] whitespace-nowrap [&::-webkit-scrollbar]:hidden">
            {[
              `${sujets.length} sujets publiés`,
              "Examinateur IA",
              `Correction /${COMPETENCY_MAX}`,
            ].map((fact, index) => (
              <span key={fact} className="flex shrink-0 items-center gap-3">
                {index > 0 && (
                  <span aria-hidden className="text-border">
                    ·
                  </span>
                )}
                {fact}
              </span>
            ))}
          </div>
          <div className="bg-border h-px" />
        </div>
      </header>

      {/* `relative` anchors the `sr-only` label — absolute, and without a
          positioned ancestor it would anchor to the document (#114). */}
      <div className="relative mt-6">
        <label htmlFor={searchId} className="sr-only">
          Rechercher un sujet
        </label>
        <div className="border-border bg-card focus-within:border-primary/60 flex items-center gap-2 rounded-md border px-3 py-2 transition-colors">
          <SearchIcon className="text-muted-foreground size-4 shrink-0" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un thème, un mot du document…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        {/* Polite, and counted rather than merely re-rendered: a candidate
            filtering a list they cannot see needs to hear that it changed. */}
        <p role="status" aria-live="polite" className="text-muted-foreground mt-2 text-xs">
          {query
            ? `${filtered.length} sujet${filtered.length > 1 ? "s" : ""} sur ${sujets.length}`
            : `${sujets.length} sujets`}
        </p>
      </div>

      {filtered.length === 0 ? (
        <p className="border-border text-muted-foreground sheet mt-6 border border-dashed px-6 py-12 text-center text-sm">
          Aucun sujet ne correspond à « {query} ».
        </p>
      ) : (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((sujet) => (
            <li key={sujet.slug} className="flex">
              <SujetCard
                sujet={sujet}
                // The catalogue's own numbering, not the filtered list's: a
                // search that renumbered the cards would make "Sujet 03" mean
                // something different for every query.
                position={sujets.indexOf(sujet) + 1}
                onOpen={() => setOpenSlug(sujet.slug)}
              />
            </li>
          ))}
        </ul>
      )}

      <SujetSheet sujet={open} onClose={() => setOpenSlug(null)} />
    </main>
  );
}

/** Accent- and case-insensitive, so "telelravail" finds « télétravail ». */
function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * One sujet on the newsstand.
 *
 * The whole card is the button — the headline is not a separate link — because
 * there is exactly one thing to do with a card, and a card you can only click in
 * one small place is a card that feels broken. The reference's rule, kept.
 */
function SujetCard({
  sujet,
  position,
  onOpen,
}: {
  sujet: KioskSujet;
  position: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Lire le sujet : ${sujet.title}`}
      // Paper stock, matching the hub's row and the sheet behind it: a stack of
      // sujets rather than a grid of cards.
      className="group border-paper-border bg-paper hover:border-primary/60 sheet flex h-full w-full cursor-pointer flex-col items-start border p-5 text-left transition-colors"
    >
      <div className="flex w-full items-center justify-between gap-2.5">
        <span className="text-muted-foreground tabular text-[0.65625rem] font-medium tracking-[0.06em]">
          Sujet {position.toString().padStart(2, "0")}
        </span>
        {/* No ✓ beside it any more: the pill is coloured on the /25 scale now,
            and a tick on a 6/25 in a red pill reads as approval of the mark
            rather than as "already sat". */}
        {sujet.score !== null && <ScoreTag score25={sujet.score} />}
      </div>

      {/* Sans, not the serif: the serif is spent on the masthead and on the
          sheet's own headline. Repeating it across a grid turns every card into
          a flourish and none of them into a hierarchy. */}
      <h2 className="mt-3.5 line-clamp-3 text-lg leading-snug font-semibold tracking-tight">
        {sujet.title}
      </h2>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed">
        {sujet.teaser}
      </p>

      <div className="mt-auto flex w-full items-center justify-between gap-2 pt-4">
        <span className="text-muted-foreground tabular text-[0.65625rem]">{sujet.meta}</span>
        <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
          Lire le sujet
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </button>
  );
}

/**
 * The sujet, whole: the document déclencheur as it will appear in the épreuve,
 * and the consigne under it.
 *
 * A slide-over rather than a route, per the reference — the candidate is
 * browsing, and losing the grid to read one sujet costs them the comparison they
 * came to make. Built on `<dialog>` for the focus trap and the Escape key, which
 * is the same reason `ExitDialog` uses it.
 *
 * The footer's « Passer l'épreuve » IS the launch (#131): it creates the exam
 * row and navigates into the préparation, with no confirmation dialog between.
 * The candidate is looking at the whole sujet — document, consigne, durée —
 * which is everything the dialog used to restate.
 */
function SujetSheet({ sujet, onClose }: { sujet: KioskSujet | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (sujet && !dialog.open) dialog.showModal();
    if (!sujet && dialog.open) dialog.close();
  }, [sujet]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="sujet-sheet-title"
      className="bg-card text-foreground border-border my-0 ml-auto h-full max-h-full w-[min(38rem,100vw)] max-w-full border-l p-0 backdrop:bg-black/40"
    >
      {sujet && (
        <div className="flex h-full flex-col">
          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
            <Kicker>Sujet · Production orale</Kicker>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer le sujet"
              className="border-border bg-card text-muted-foreground hover:bg-muted flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors"
            >
              <CloseIcon className="size-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            <h2
              id="sujet-sheet-title"
              className="font-serif text-2xl leading-snug font-semibold text-balance"
            >
              {sujet.title}
            </h2>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Tag>{sujet.kind}</Tag>
              <Tag>{sujet.meta}</Tag>
              {sujet.score !== null && <ScoreTag score25={sujet.score} prefix="Déjà passé" />}
            </div>

            {/* The same paper stock the épreuve prints it on, so the thing the
                candidate reads here and the thing they meet inside the exam are
                visibly the same object. */}
            <div className="border-paper-border bg-paper sheet mt-6 border p-5 sm:p-6">
              <h3 className="text-muted-foreground border-border border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                Document déclencheur
              </h3>
              <p className="document-text mt-4">{sujet.topic.document}</p>

              <h3 className="text-muted-foreground border-border mt-8 border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                Consigne
              </h3>
              <p className="document-text mt-4">{sujet.topic.consigne}</p>
            </div>
          </div>

          <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
            {/* The dead dialog's one load-bearing line, folded into the durée it
                sat next to: the clock starts the moment the button is pressed. */}
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <ClockIcon className="size-3.5 shrink-0" />
              La préparation ({PHASE_DURATIONS.preparation / 60} min) démarre dès l&apos;ouverture.
            </span>
            <StartExamButton topicSlug={sujet.slug} topicTitle={sujet.title} />
          </div>
        </div>
      )}
    </dialog>
  );
}
