import Link from "next/link";

import {
  ArrowRightIcon,
  ChartIcon,
  CheckCircleIcon,
  ClockIcon,
  GridCheckIcon,
} from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import type { HubCapability, HubSujet, HubView } from "@/lib/ui/epreuve-hub";

/**
 * The four blocks of the hub, reproduced from the reference's
 * `components/epreuve-hub/*`: masthead, format, sujets à la une, capabilities.
 *
 * They live in one file rather than four because each is a dozen lines here —
 * the reference splits them across files because two épreuves render the same
 * four blocks from one view model and each had a design argument long enough to
 * need its own header. Those arguments are preserved as comments where they
 * still decide something; the file split had no reader left once there was one
 * épreuve.
 *
 * The rule they all obey, and the reason the view model exists: **these
 * components never learn a fact about the épreuve.** Every number, every label
 * and every link arrives through `HubView`.
 */

/**
 * The hub's opening: one serif headline, the lead, and the shape pill.
 *
 * The reference's note is worth keeping because it is a rule and not a
 * preference — the épreuve landing is an editorial surface, so a serif headline
 * is allowed here, but headlines only and exactly one per view. This `h1` is the
 * only serif on the hub; the sujet titles below are all sans.
 *
 * The shape pill is neutral: it states the épreuve's format, which is reference,
 * not status. Colouring it would spend an accent on something that carries none.
 */
export function HubMasthead({ view }: { view: HubView }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="font-serif max-w-[18ch] text-[2.375rem] leading-[1.05] font-semibold tracking-tight sm:text-[2.875rem]">
          {view.title}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-[56ch] text-[0.96875rem] leading-[1.65]">
          {view.lead}
        </p>
      </div>
      <Tag className="mt-1.5 shrink-0">{view.shapePill}</Tag>
    </div>
  );
}

/**
 * « Le format de l'épreuve » — what it asks of you, and what it is marked
 * against.
 *
 * One card per partie, drawn from the same `HubFormatItem`. The criteria ride on
 * the LAST card behind a hairline rather than in a card of their own: the grid
 * is the épreuve's, not the partie's, so it belongs after every partie has been
 * described and never between two of them. Five short chips do not need their
 * own card, which is the height the reference saved by moving them.
 */
export function HubFormat({ view }: { view: HubView }) {
  const lastIndex = view.format.length - 1;

  return (
    <section className="mt-10">
      <h2 className="font-serif text-lg font-semibold tracking-tight">
        Le format de l&apos;épreuve
      </h2>

      <div className="mt-4 grid gap-4">
        {view.format.map((item, index) => (
          <div key={item.key} className="border-border bg-card rounded-lg border p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Tag>{item.pill}</Tag>
              <h3 className="text-base font-semibold tracking-tight">{item.title}</h3>
            </div>

            <p className="text-muted-foreground mt-3 max-w-[70ch] text-sm leading-[1.7]">
              {item.description}
            </p>

            <ul className="mt-4 flex flex-wrap gap-1.5">
              {item.facts.map((fact) => (
                <li key={fact}>
                  <Tag>{fact}</Tag>
                </li>
              ))}
            </ul>

            {index === lastIndex && (
              <div className="border-border mt-5 border-t pt-4">
                <Kicker>Ce que l&apos;examinateur note</Kicker>
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {view.criteria.map((criterion) => (
                    <li key={criterion}>
                      <Tag>{criterion}</Tag>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * « Sujets à la une » — a few real sujets, straight from the catalogue.
 *
 * The reference's colour rule, kept verbatim because it is what stops this grid
 * turning into a fruit salad: the kind pill is neutral and the score is the
 * card's one accent. Every card has a kind, so colouring it classifies nothing;
 * only some cards have a score, so that is the one allowed to mean something.
 *
 * The card is one `<Link>` rather than a card with a button in it, so the whole
 * surface is the target and there is exactly one tab stop per sujet.
 */
export function HubSujets({
  sujets,
  allSujetsHref,
}: {
  sujets: readonly HubSujet[];
  allSujetsHref: string;
}) {
  if (sujets.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold tracking-tight">Sujets à la une</h2>
        <Link
          href={allSujetsHref}
          className="text-primary shrink-0 text-xs font-semibold hover:underline"
        >
          Tous les sujets
        </Link>
      </div>

      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sujets.map((sujet) => (
          <li key={sujet.slug} className="flex">
            <Link
              // Straight to this sujet's sheet on the kiosk, rather than to the
              // top of the page with a hash the grid would have to hunt for.
              href={`${allSujetsHref}?sujet=${sujet.slug}`}
              className="group border-border bg-card hover:border-primary/60 flex w-full flex-col rounded-lg border p-5 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <Tag>{sujet.kind}</Tag>
                {sujet.score !== null && (
                  <Tag tone="success">
                    <CheckCircleIcon className="size-3" />
                    {sujet.score}/{COMPETENCY_MAX}
                  </Tag>
                )}
              </div>

              <h3 className="mt-3 line-clamp-3 text-[0.9375rem] leading-snug font-semibold tracking-tight">
                {sujet.title}
              </h3>

              <div className="mt-auto flex items-center justify-between gap-2 pt-5">
                <span className="text-muted-foreground tabular text-xs">{sujet.meta}</span>
                <span className="text-primary inline-flex items-center gap-1 text-xs font-semibold">
                  {sujet.score === null ? "Commencer" : "Refaire"}
                  <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The slim three-up strip that closes the hub: what this product does for the
 * épreuve, in one line each.
 *
 * The view model names an icon by role rather than importing one, so the copy
 * layer stays free of component concerns and this map is the only place that
 * knows what a glyph is. One icon per panel and no more — here the icon is the
 * panel's whole left column, doing the work a heading would otherwise repeat.
 */
const CAPABILITY_ICONS: Record<
  HubCapability["icon"],
  (props: { className?: string }) => React.ReactElement
> = {
  conditions: ClockIcon,
  correction: GridCheckIcon,
  score: ChartIcon,
};

export function HubCapabilities({ view }: { view: HubView }) {
  return (
    <section className="border-border bg-card mt-10 grid rounded-lg border sm:grid-cols-3">
      {view.capabilities.map((capability, index) => {
        const Glyph = CAPABILITY_ICONS[capability.icon];
        return (
          <div
            key={capability.title}
            className={
              index > 0
                ? "border-border flex items-start gap-3 border-t p-5 sm:border-t-0 sm:border-l"
                : "flex items-start gap-3 p-5"
            }
          >
            <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
              <Glyph className="size-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[0.8125rem] font-semibold">{capability.title}</h3>
              <p className="text-muted-foreground mt-1 text-xs leading-[1.5]">
                {capability.description}
              </p>
            </div>
          </div>
        );
      })}
    </section>
  );
}
