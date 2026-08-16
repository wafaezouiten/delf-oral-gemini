"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ArrowRightIcon, CheckCircleIcon, ClockIcon, CloseIcon, SearchIcon } from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import { StartExamButton } from "@/app/app/(hub)/_components/start-exam-button";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { HubSujet } from "@/lib/ui/epreuve-hub";

/**
 * The sujets kiosk: the catalogue, a sujet's full sheet, and the confirmation
 * before the clock starts.
 *
 * PORT NOTE: the reference's `components/sujets/*` — `SujetsMasthead`,
 * `SujetCard`, `SujetDetailSheet` and `SujetLaunchDialog` — reproduced as one
 * client component. The reference splits them across five files because the same
 * kiosk serves the écrite and the orale catalogues from a shared `SujetItem`;
 * with one catalogue there is nothing to share with, and the search state that
 * forced its client boundary is the only state here.
 *
 * Two of the reference's controls are deliberately NOT reproduced:
 *
 *  - **The facet chips.** It facets by DELF partie because its catalogue mixes
 *    A1–B2 parts and a candidate genuinely browses by "Monologue suivi" vs
 *    "Débat". Every sujet here is the same B2 épreuve — monologue *and* débat —
 *    so the toolbar would render a single chip reading the catalogue's own size,
 *    which is a filter that filters nothing.
 *  - **The `[month]` route.** Its sujets carry a publication month; these do not,
 *    and inventing one from the seed order would be a fabricated date on a page
 *    whose whole promise is that the sujets are current.
 *
 * The three-step flow IS reproduced, because it is the interaction pattern the
 * issue asks to preserve: card → sheet (read the whole sujet) → dialog (commit).
 * The reference's reason for the last step is worth keeping — the candidate has
 * already read the consigne in the sheet, so the dialog states only the thing
 * they cannot undo, which is that the clock starts.
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
  const [launching, setLaunching] = useState(false);
  const searchId = useId();

  const filtered = useMemo(() => {
    const needle = normalise(query);
    if (!needle) return sujets;
    return sujets.filter(
      (sujet) =>
        normalise(sujet.title).includes(needle) ||
        normalise(sujet.topic.document).includes(needle),
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
          Des débats d&apos;actualité transformés en sujets d&apos;examen : le
          document déclencheur, la consigne officielle, puis un examinateur qui
          vous répond et vous note sur {COMPETENCY_MAX}.
        </p>

        {/* The facts, banded between two hairlines: a quiet strip that separates
            the title from the catalogue without a rule heavy enough to read as a
            divider dropped across the page. One line, always — on a narrow
            screen it scrolls sideways rather than breaking, because a phrase
            wrapped inside a banded strip reads as a layout fault. */}
        <div className="mt-7">
          <div className="bg-border h-px" />
          <div className="text-muted-foreground tabular flex items-center gap-x-3 overflow-x-auto py-3 text-[0.6875rem] font-medium tracking-[0.04em] whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

      <div className="mt-6">
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
        <p className="border-border text-muted-foreground mt-6 rounded-lg border border-dashed px-6 py-12 text-center text-sm">
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

      <SujetSheet
        sujet={open}
        onClose={() => {
          setOpenSlug(null);
          setLaunching(false);
        }}
        onLaunch={() => setLaunching(true)}
      />

      <LaunchDialog
        sujet={launching ? open : null}
        onClose={() => setLaunching(false)}
      />
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
      className="group border-border bg-card hover:border-primary/60 flex h-full w-full cursor-pointer flex-col items-start rounded-lg border p-5 text-left transition-colors"
    >
      <div className="flex w-full items-center justify-between gap-2.5">
        <span className="text-muted-foreground tabular text-[0.65625rem] font-medium tracking-[0.06em]">
          Sujet {position.toString().padStart(2, "0")}
        </span>
        {sujet.score !== null && (
          <Tag tone="success">
            <CheckCircleIcon className="size-3" />
            {sujet.score}/{COMPETENCY_MAX}
          </Tag>
        )}
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
 */
function SujetSheet({
  sujet,
  onClose,
  onLaunch,
}: {
  sujet: KioskSujet | null;
  onClose: () => void;
  onLaunch: () => void;
}) {
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
            <h2 id="sujet-sheet-title" className="font-serif text-2xl leading-snug font-semibold text-balance">
              {sujet.title}
            </h2>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Tag>{sujet.kind}</Tag>
              <Tag>{sujet.meta}</Tag>
              {sujet.score !== null && (
                <Tag tone="success">
                  <CheckCircleIcon className="size-3" />
                  Déjà passé · {sujet.score}/{COMPETENCY_MAX}
                </Tag>
              )}
            </div>

            {/* The same paper stock the épreuve prints it on, so the thing the
                candidate reads here and the thing they meet inside the exam are
                visibly the same object. */}
            <div className="border-paper-border bg-paper mt-6 rounded-lg border p-5 sm:p-6">
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

          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t px-6 py-4">
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <ClockIcon className="size-3.5 shrink-0" />
              {PHASE_DURATIONS.preparation / 60} min de préparation avant de parler
            </span>
            <button
              type="button"
              onClick={onLaunch}
              className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
            >
              Passer l&apos;épreuve
              <ArrowRightIcon className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/**
 * The last step before the épreuve: what you are about to sit, and the one thing
 * about to happen that cannot be undone.
 *
 * Deliberately quiet, per the reference: the facts already shown, three
 * reminders, one button. Nothing new is introduced at the point of no return.
 */
const LAUNCH_NOTES = [
  "Prenez le temps de préparer vos arguments et vos exemples.",
  "Parlez à voix haute : l'examinateur vous répond et vous conteste.",
  "Vos deux prises de parole sont enregistrées, puis corrigées.",
];

function LaunchDialog({ sujet, onClose }: { sujet: KioskSujet | null; onClose: () => void }) {
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
      aria-labelledby="launch-dialog-title"
      className="bg-card text-foreground border-border m-auto w-[min(29rem,92vw)] rounded-lg border p-0 backdrop:bg-black/50"
    >
      {sujet && (
        <div className="space-y-4 p-6">
          <div>
            <Kicker>Monologue suivi et débat</Kicker>
            <h2 id="launch-dialog-title" className="mt-1 text-[1.0625rem] leading-snug font-semibold tracking-tight">
              {sujet.title}
            </h2>
          </div>

          <div className="border-border bg-muted/40 tabular rounded-md border px-3.5 py-2.5 text-xs font-medium">
            {sujet.meta}
          </div>

          <ul className="flex flex-col gap-2">
            {LAUNCH_NOTES.map((note) => (
              <li
                key={note}
                className="text-muted-foreground flex items-start gap-2.5 text-[0.8125rem] leading-snug"
              >
                <CheckCircleIcon className="text-muted-foreground/60 mt-px size-4 shrink-0" />
                {note}
              </li>
            ))}
          </ul>

          <div className="bg-border h-px" />

          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* The only irreversible thing on this screen, so the only thing
                that gets to sit next to the button. */}
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[0.71875rem]">
              <ClockIcon className="size-3.5 shrink-0" />
              La préparation démarre dès l&apos;ouverture.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 text-sm font-semibold transition-colors"
              >
                Annuler
              </button>
              <StartExamButton
                topicSlug={sujet.slug}
                topicTitle={sujet.title}
                label="Commencer"
              />
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
