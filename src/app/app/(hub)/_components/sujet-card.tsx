import Link from "next/link";
import type { ReactNode } from "react";

import { ArrowRightIcon } from "@/app/_components/po/icons";
import { ScoreTag, scoreSurface } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import type { HubSujet } from "@/lib/ui/epreuve-hub";

/**
 * One sujet, as a card — the same object on the hub's « Sujets à la une » and
 * on the kiosk's grid (#188).
 *
 * Before #188 the two surfaces each drew their own: the same paper, the same
 * header and the same footer, hand-copied, and already drifting (the kiosk had
 * grown a number and a teaser the hub never got). One component now, and the
 * two differ only in what they are handed: an `eyebrow` for the top-left
 * corner (the kiosk's numbering; the hub has none, so its score sits alone at
 * the right), an `action` for the footer's verb, and where the card leads.
 *
 * Where it leads is the one structural difference. The kiosk opens a sheet, so
 * its card is a `<button>`; the hub sends the candidate to that sheet on the
 * kiosk, so its card is a `<Link>`. Either way the whole surface is the target
 * and there is exactly one tab stop per sujet — a card you can only click in
 * one small place is a card that feels broken. The reference's rule, kept.
 *
 * **The card wears its band.** A sujet the candidate has already sat takes the
 * fill and the ring of its last /25, on the same five-step scale as the pill
 * (`scoreSurface`); a sujet never sat stays on the neutral paper stock. The
 * tint is a redundant encoding of the figure in the pill, never the message
 * (#50): no band name is printed, and every fill was checked to hold AA for the
 * muted meta line as well as the title. The pill switches to its solid variant
 * on a tinted card, because a tinted pill on its own tint is a ring and nothing
 * else.
 *
 * `.sujet-card` carries the radius: the one rounded surface in a product that
 * is otherwise squared off to `.sheet`'s 2px, defined once in `globals.css` so
 * the two catalogues cannot round differently.
 */
export function SujetCard({
  sujet,
  eyebrow,
  action,
  headingLevel: Heading = "h3",
  ...target
}: {
  sujet: HubSujet;
  /** The top-left corner: the kiosk's « Sujet 03 ». Omitted on the hub. */
  eyebrow?: ReactNode;
  /** The footer's verb: « Lire le sujet », « Commencer », « Refaire ». */
  action: string;
  /** The hub sits under `h2` section headings; the kiosk's cards are its `h2`s. */
  headingLevel?: "h2" | "h3";
} & (
  | { href: string; onOpen?: undefined; ariaLabel?: undefined }
  | { onOpen: () => void; ariaLabel: string; href?: undefined }
)) {
  const className = cn(
    "group sujet-card hover:border-primary/60 flex h-full w-full cursor-pointer flex-col items-start border p-4 text-left transition-colors sm:p-5",
    sujet.score === null ? "border-paper-border bg-paper" : scoreSurface(sujet.score),
  );

  const body = (
    <>
      {/* The header row is only drawn when it has something in it, so a card
          with neither eyebrow nor score starts at its title rather than under
          an empty line. `ml-auto` keeps the pill at the right when it is alone. */}
      {(eyebrow || sujet.score !== null) && (
        <div className="flex w-full items-center justify-between gap-2.5">
          {eyebrow}
          {/* No ✓ beside it: a tick on a 6/25 in a red pill reads as approval
              of the mark rather than as "already sat", and the footer's verb
              already says « Refaire » for that. */}
          {sujet.score !== null && (
            <ScoreTag score25={sujet.score} variant="solid" className="ml-auto" />
          )}
        </div>
      )}

      {/* Sans, not the serif: the serif is spent on the masthead and on the
          sheet's own headline. Repeating it across a grid turns every card into
          a flourish and none of them into a hierarchy. */}
      <Heading className="mt-3.5 line-clamp-3 text-lg leading-snug font-semibold tracking-tight first:mt-0">
        {sujet.title}
      </Heading>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed">
        {sujet.teaser}
      </p>

      <div className="mt-auto flex w-full items-center justify-between gap-2 pt-4">
        <span className="text-muted-foreground tabular text-[0.65625rem]">{sujet.meta}</span>
        <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
          {action}
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
