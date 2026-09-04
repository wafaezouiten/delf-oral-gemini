import Link from "next/link";

import { ChartIcon, ClockIcon, GridCheckIcon } from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import type { HubCapability, HubSujet, HubView } from "@/lib/ui/epreuve-hub";
import { SujetCard } from "./sujet-card";

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
 * A section heading, set as an exam booklet sets one: a numbered kicker, a serif
 * line, and the double rule a corrector's grid uses to close a block.
 *
 * This is the main thing that keeps the hub from reading as the reference's
 * (rounded cards under a bold sans heading) while changing nothing structural.
 * The numeral is `aria-hidden`: it is stationery, and a screen reader announcing
 * "zero one, Le format de l'épreuve" is being read the furniture.
 */
function SectionHeading({
  n,
  children,
  right,
}: {
  n: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rule-double flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2">
      <h2 className="flex items-baseline gap-2.5">
        <span className="text-primary/50 tabular text-xs font-semibold" aria-hidden>
          {n}
        </span>
        <span className="font-serif text-lg font-semibold tracking-tight">{children}</span>
      </h2>
      {right}
    </div>
  );
}

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
        <h1 className="max-w-[18ch] font-serif text-[2.375rem] leading-[1.05] font-semibold tracking-tight sm:text-[2.875rem]">
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
      <SectionHeading n="01">Le format de l&apos;épreuve</SectionHeading>

      <div className="mt-4 grid gap-3">
        {view.format.map((item, index) => (
          <div key={item.key} className="border-border bg-card sheet border p-4 sm:p-5">
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
 * « Sujets à la une » — the first three sujets of the catalogue (#188), drawn
 * with the kiosk's own card so the two grids are one object.
 *
 * The reference's colour rule, kept because it is what stops this grid turning
 * into a fruit salad: the score is the card's one accent. Only some cards have
 * a score, so that is the one allowed to mean something — and since #188 it
 * colours the whole card, not only the pill. The kind pill the reference put
 * beside it is gone from this grid: every sujet here is the same épreuve, so it
 * classified nothing (the sheet on the kiosk still names the kind).
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
      <SectionHeading
        n="02"
        right={
          <Link
            href={allSujetsHref}
            className="text-primary shrink-0 text-xs font-semibold hover:underline"
          >
            Tous les sujets
          </Link>
        }
      >
        Sujets à la une
      </SectionHeading>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sujets.map((sujet) => (
          <li key={sujet.slug} className="flex">
            <SujetCard
              sujet={sujet}
              // No kind pill: every card here is « Monologue et débat », so the
              // pill classified nothing, and the section heading already says
              // what these are. The score alone sits in the header row.
              action={sujet.score === null ? "Commencer" : "Refaire"}
              // Straight to this sujet's sheet on the kiosk, rather than to the
              // top of the page with a hash the grid would have to hunt for.
              href={`${allSujetsHref}?sujet=${sujet.slug}`}
            />
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
    <section className="border-border bg-card sheet mt-10 grid border sm:grid-cols-3">
      {view.capabilities.map((capability, index) => {
        const Glyph = CAPABILITY_ICONS[capability.icon];
        return (
          <div
            key={capability.title}
            className={
              index > 0
                ? "border-border flex items-start gap-3 border-t p-4 sm:border-t-0 sm:border-l"
                : "flex items-start gap-3 p-4"
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
