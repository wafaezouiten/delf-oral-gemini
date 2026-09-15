import Link from "next/link";

import { ArrowRightIcon } from "@/app/_components/po/icons";
import { ScoreTag, scoreSurface } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { formatSujetNumber, sujetCardVerb, type HubSujet } from "@/lib/ui/epreuve-hub";

/**
 * One sujet, as a card — the same object on the hub's « Sujets à la une » and
 * on the kiosk's grid (#188), and the main project's design for it
 * (delf-preps, `components/sujets/sujet-card-body.tsx`).
 *
 * Before #188 the two surfaces each drew their own: the same paper, the same
 * header and the same footer, hand-copied, and already drifting (the kiosk had
 * grown a number and a teaser the hub never got). One component now, drawing
 * the number, the title, the teaser and the facts on both surfaces; the two
 * differ only in where the card leads.
 *
 * Where it leads is the one structural difference. The kiosk opens a sheet, so
 * its card is a `<button>`; the hub sends the candidate to that sheet on the
 * kiosk, so its card is a `<Link>`. Either way the whole surface is the target
 * and there is exactly one tab stop per sujet — a card you can only click in
 * one small place is a card that feels broken. The reference's rule, kept.
 *
 * **The card wears its band.** A sujet the candidate has already sat takes the
 * wash and the ring of its last /25, on the same five-step scale as the pill
 * (`scoreSurface`); a sujet never sat stays on the neutral paper stock, because
 * it has no result to be coloured by, and a grid where every card is tinted
 * says nothing. The tint is a redundant encoding of the figure in the pill,
 * never the message (#50): no band name is printed. The pill sits on a white
 * chip on a tinted card, since a tinted pill on its own tint sinks into it.
 *
 * **The verb follows the state, not the surface.** « Lire le sujet » on a
 * sujet never sat and « Refaire » once it carries a score, on the hub as on the
 * kiosk: the card opens the sheet, it does not start the épreuve, and the
 * sheet's own « Passer l'épreuve » is where the start lives (#131). The hub
 * used to say « Commencer » here for the same untouched sujet the kiosk called
 * « Lire le sujet », which named one action with two words.
 *
 * `.sujet-card` carries the radius: the one rounded surface in a product that
 * is otherwise squared off to `.sheet`'s 2px, defined once in `globals.css` so
 * the two catalogues cannot round differently.
 */
export function SujetCard({
  sujet,
  position,
  headingLevel: Heading = "h3",
  ...target
}: {
  sujet: HubSujet;
  /** What « N° 03 » counts: the sujet's position in the published catalogue. */
  position: number;
  /** The hub sits under `h2` section headings; the kiosk's cards are its `h2`s. */
  headingLevel?: "h2" | "h3";
} & (
  | { href: string; onOpen?: undefined; ariaLabel?: undefined }
  | { onOpen: () => void; ariaLabel: string; href?: undefined }
)) {
  const score = sujet.score;
  const className = cn(
    "group sujet-card flex h-full w-full cursor-pointer flex-col items-start border p-5 text-left transition-colors sm:p-[22px]",
    score !== null ? scoreSurface(score) : "border-paper-border bg-paper hover:border-primary/60",
  );

  const body = (
    <>
      {/* min-h-5, the height of one pill: the score lands on a minority of
          cards, and a row that grows only where a pill exists would start the
          headlines of one grid row at two different heights. */}
      <div className="flex min-h-5 w-full items-center justify-between gap-2.5">
        <span className="text-muted-foreground tabular text-[0.65625rem] font-medium tracking-[0.06em]">
          {formatSujetNumber(position)}
        </span>
        {/* No ✓ beside it: a tick on a 6/25 in a red pill reads as approval of
            the mark rather than as "already sat", and the footer's verb already
            says « Refaire » for that. */}
        {score !== null && <ScoreTag score25={score} variant="chip" />}
      </div>

      {/* Sans, not the serif: the serif is spent on the masthead and on the
          sheet's own headline. Repeating it across a grid turns every card into
          a flourish and none of them into a hierarchy. */}
      <Heading className="mt-3.5 line-clamp-3 text-lg leading-snug font-semibold tracking-tight">
        {sujet.title}
      </Heading>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed">
        {sujet.teaser}
      </p>

      <div className="mt-auto flex w-full items-center justify-between gap-2 pt-4">
        <span className="text-muted-foreground tabular text-[0.65625rem]">{sujet.meta}</span>
        <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
          {sujetCardVerb(score)}
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </>
  );

  if (target.href !== undefined) {
    return (
      <Link href={target.href} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={target.onOpen}
      aria-label={target.ariaLabel}
      className={className}
    >
      {body}
    </button>
  );
}
