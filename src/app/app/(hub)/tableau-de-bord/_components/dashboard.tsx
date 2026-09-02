import Link from "next/link";

import { primaryButton, secondaryButton } from "@/app/_components/button-styles";
import { ChartIcon, MicIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { ScoreTag, scoreFill, scoreInk } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import { formatScore25 } from "@/lib/ui/format-score";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import {
  formatScoreDelta,
  TRAJECTORY_TICKS,
  type DashboardView,
  type TrajectoryPoint,
  type TrajectoryView,
} from "@/lib/ui/dashboard-view";
import { SittingRow } from "../../_components/sitting-row";

/**
 * The tableau de bord, as pure presentation — no fetching, so it renders from a
 * view model alone.
 *
 * PORT NOTE: the reference's `/production-orale/tableau-de-bord` page body —
 * four stat tiles, a bar chart, a recent list, and an empty state that offers
 * the way to a first épreuve rather than an apology. All four reproduced.
 *
 * The chart changed twice and `lib/ui/dashboard-view.ts` carries the argument:
 * the reference's per-partie averages cannot exist here (a sitting is the whole
 * épreuve with one /25), a per-criterion substitute stood in until #143, and
 * the chart is now « Votre trajectoire » — one bar per simulation on the /25.
 *
 * Split from the page so the arithmetic is unit-tested (`dashboard-view.test.ts`)
 * and the layout is renderable from fixtures. The reference keeps both in the
 * route file and pays for it by being unable to look at either without a
 * database and a signed-in user.
 */
export function Dashboard({ view }: { view: DashboardView }) {
  if (view.count === 0) return <EmptyDashboard />;

  return (
    // The density rule this pass applies across the product (#185): a card's
    // interior is 14 px on a phone and 16-24 px above it, a section's header
    // band is 12 px tall rather than 16, and a page's own rhythm is 24/32
    // rather than 40. Nothing is removed and no type shrinks below the sizes
    // the product already uses — the screens simply stopped spending a third
    // of a phone on white space between figures a candidate is comparing.
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <Kicker>DELF B2 · Production orale</Kicker>
          <h1 className="mt-1 font-serif text-2xl leading-tight font-semibold">Tableau de bord</h1>
        </div>
        <Link href={HUB_LINKS.sujets} className={secondaryButton}>
          Nouvelle épreuve
        </Link>
      </div>

      {/* One section divided in four, not four cards (#185). The figures are
          four readings of one record — a mark, a rate, a duration and a run —
          and four separate frames stacked down a phone read as four unrelated
          things and cost three extra gaps of vertical space. They now share a
          sheet and are told apart by rules.

          **Two by two on a phone, four across from `lg`** — never one under
          another (#185). Stacked, the section was four full-width bands and
          read as the four separate cards it had just stopped being; quartered,
          the division is visible without scrolling and the whole standing fits
          one glance. Four across on a 390 px screen is not the alternative: it
          leaves 69 px of content per cell, and « sur 25, 2 épreuves dont 2
          abandonnées » does not go in 69 px.

          The rules are the grid's own gaps rather than borders — `gap-px` over
          a `bg-border` container, each cell painted `bg-card` — which leaves
          exactly one hairline between every pair of neighbours and none at the
          edges, at one, two or four columns, with no arithmetic. `divide-x`
          could not: it rules DOM order rather than visual rows, so on the 2×2
          it draws a line down the left edge of the third cell, which is the
          sheet's own border. */}
      <ul className="border-border bg-border sheet mt-5 grid grid-cols-2 gap-px border lg:grid-cols-4">
        {view.tiles.map((tile) => (
          <li key={tile.key} className="bg-card p-3 sm:p-4">
            {/* The kicker loses a little of its tracking on a phone: at
                0.16em « AU-DESSUS DU SEUIL » takes three lines in half a
                390 px screen, and the four cells then have four different
                heights. */}
            <p className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.1em] uppercase sm:text-[0.6875rem] sm:tracking-[0.16em]">
              {tile.label}
            </p>
            {/* The one tile whose figure is a /25 is tinted on the /25 scale.
                The other three are a percentage, a duration and a day count,
                which are not marks and are left in the ink everything else is
                set in — tinting them would claim a 40 % pass rate was orange. */}
            <p
              className={cn(
                "tabular mt-1.5 font-serif text-2xl leading-none font-semibold sm:text-3xl",
                tile.band && scoreInk(tile.band.tone),
              )}
            >
              {tile.value}
            </p>
            <p className="text-muted-foreground mt-1.5 text-[0.6875rem] leading-snug sm:text-xs">
              {tile.caption}
            </p>
          </li>
        ))}
      </ul>

      <TrajectoryCard trajectory={view.trajectory} />

      <section className="border-border bg-card sheet mt-5 border">
        <div className="rule-double flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 sm:px-6">
          <h2 className="font-serif text-base font-semibold">Dernières épreuves</h2>
          {view.count > view.recent.length && (
            <Link
              href={HUB_LINKS.historique}
              className="text-primary shrink-0 text-xs font-semibold hover:underline"
            >
              Tout l&apos;historique ({view.count})
            </Link>
          )}
        </div>
        <ul className="divide-border divide-y">
          {view.recent.map((sitting) => (
            <SittingRow key={sitting.examId} sitting={sitting} />
          ))}
        </ul>
      </section>
    </main>
  );
}

/**
 * « Votre trajectoire » (#143): one bar per simulation on the /25 scale,
 * oldest to newest, each tinted on the grille's bands — the same scale every
 * printed /25 already wears — with the standing at a glance in the header: the
 * latest note, its movement since the simulation before, and its date.
 *
 * The heights come from the view model (`percent` is a share of the /25) so
 * the arithmetic is unit-tested; this file only turns percentages into
 * heights, and flexbox spaces the bars. The gridlines and the seuil line are
 * positioned on the same percentage frame, and the tooltip machinery is plain
 * CSS hover/focus — the page stays a server component.
 *
 * A walk-out is a real bar: a red sliver on the floor, because a 0/25 with no
 * height would be invisible and the exit dialog promises it counts.
 */
function TrajectoryCard({ trajectory }: { trajectory: TrajectoryView }) {
  const { points, latest, delta } = trajectory;
  if (!latest) return null;

  return (
    <section className="border-border bg-card sheet mt-5 border">
      {/* The note stays on the heading's line, at its right, at every width
          (#185). It wrapped onto a line of its own below `sm`, which put the
          one figure this card exists for under the caption rather than beside
          the title — so the row no longer wraps, the two blocks are held apart
          by `justify-between`, and the note shrinks its numeral on a phone
          rather than taking a second line. `items-baseline` sits the /25 on
          the same baseline as « Votre trajectoire » instead of aligning the
          two blocks' top edges, which is what left a 24 px numeral floating
          above a 16 px heading (#183). */}
      <div className="rule-double flex flex-nowrap items-baseline justify-between gap-x-3 px-4 py-3 sm:gap-x-6 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ChartIcon className="text-muted-foreground size-4 shrink-0" />
            <h2 className="truncate font-serif text-base font-semibold">Votre trajectoire</h2>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Score /{COMPETENCY_MAX} · par simulation
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="flex items-baseline justify-end gap-1.5 sm:gap-2">
            {/* The note is a /25, so it is tinted on the /25 scale — the same
                rule as the « Note moyenne » tile, band computed in the view
                model. */}
            <span
              className={cn(
                "tabular font-serif text-xl leading-none font-semibold sm:text-2xl",
                scoreInk(latest.band.tone),
              )}
            >
              {formatScore25(latest.score25)}
              <span className="text-muted-foreground text-xs font-normal sm:text-sm">
                /{COMPETENCY_MAX}
              </span>
            </span>
            {/* The delta is a direction, not a mark: the caret and the sign
                carry it, and the green/red is a redundant tint of that
                direction — never of a band. */}
            {delta !== null && (
              <span
                className={cn(
                  "tabular text-xs font-semibold sm:text-sm",
                  delta > 0 && "text-score-green",
                  delta < 0 && "text-score-red",
                  delta === 0 && "text-muted-foreground",
                )}
              >
                {delta !== 0 && (
                  <span aria-hidden className="text-[0.625rem]">
                    {delta > 0 ? "▲ " : "▼ "}
                  </span>
                )}
                {formatScoreDelta(delta)}
              </span>
            )}
          </p>
          <p className="text-muted-foreground mt-1 text-[0.6875rem] sm:text-xs">
            {delta !== null ? "dernière simulation" : "première simulation"} · {latest.date}
          </p>
        </div>
      </div>

      <div className="flex gap-3 px-4 pt-4 pb-5 sm:px-6">
        {/* The ruler: 25 at the top, 0 on the floor. Decoration — every figure
            it carries is also in each bar's accessible text. */}
        <div className="text-muted-foreground tabular relative h-44 w-6 shrink-0 text-right text-[0.6875rem]">
          {TRAJECTORY_TICKS.map((tick) => (
            <span
              key={tick}
              aria-hidden
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - (tick / COMPETENCY_MAX) * 100}%` }}
            >
              {tick}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-44">
            {TRAJECTORY_TICKS.map((tick) => (
              <div
                key={tick}
                aria-hidden
                className="border-border absolute inset-x-0 border-t border-dashed"
                style={{ top: `${100 - (tick / COMPETENCY_MAX) * 100}%` }}
              />
            ))}
            {/* The seuil éliminatoire, on the same frame as the bars — the one
                horizontal that is a rule rather than a ruler, so it carries its
                name. */}
            <div
              aria-hidden
              className="border-score-red/50 absolute inset-x-0 border-t border-dashed"
              style={{ top: `${100 - (COMPETENCY_FLOOR / COMPETENCY_MAX) * 100}%` }}
            >
              <span className="text-score-red/70 absolute right-0 bottom-0.5 text-[0.625rem]">
                Seuil {COMPETENCY_FLOOR}/{COMPETENCY_MAX}
              </span>
            </div>
            <div className="absolute inset-0 flex items-end gap-1.5">
              {points.map((point, index) => (
                <TrajectoryBar
                  key={point.examId}
                  point={point}
                  // The first and last bars anchor their tooltip to their own
                  // side instead of their centre, so the sujets at the edges do
                  // not run out of the card.
                  align={
                    index === 0
                      ? "left-0"
                      : index === points.length - 1
                        ? "right-0"
                        : "left-1/2 -translate-x-1/2"
                  }
                />
              ))}
            </div>
          </div>
          {/* The x-axis in dates: where the record starts, and where it is. */}
          <div className="text-muted-foreground mt-2 flex justify-between text-xs">
            <span>{points[0].date}</span>
            {points.length > 1 && <span>{latest.date}</span>}
          </div>
        </div>
      </div>

      <p className="text-muted-foreground border-border border-t px-4 py-2.5 text-xs leading-relaxed sm:px-6">
        Chaque barre est une simulation, de la première à la plus récente. Survolez une barre pour
        voir le sujet et la note ; une épreuve abandonnée compte 0/{COMPETENCY_MAX}.
      </p>
    </section>
  );
}

/**
 * One simulation: a bar tinted on its band, with the sujet and the note in a
 * tooltip on hover and on keyboard focus — the whole bar column is the hit
 * target, floor to ceiling, so a low note is no harder to point at than a high
 * one.
 *
 * The note in the tooltip is the existing `ScoreTag`, so its tint comes off
 * the grille's bands like every other /25 in the product — and the figure is
 * printed beside the colour, which is never the message: the height already
 * says it against the ruler. The same words are in an `sr-only` span so a
 * focused bar reads aloud what the tooltip shows.
 */
function TrajectoryBar({ point, align }: { point: TrajectoryPoint; align: string }) {
  return (
    <div
      tabIndex={0}
      className="group focus-visible:outline-primary relative flex h-full max-w-9 flex-1 items-end rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div
        aria-hidden
        className={cn(
          "w-full rounded-t-md",
          scoreFill(point.band.tone),
          // A walk-out's 0/25 still shows: a red sliver on the floor beats an
          // invisible bar the record swears is there.
          point.percent === 0 && "h-0.5",
        )}
        style={point.percent > 0 ? { height: `${point.percent}%` } : undefined}
      />
      <span className="sr-only">
        {point.topicTitle} — {point.score25}/{COMPETENCY_MAX}, {point.date}
        {point.outcome === "abandoned" ? ", épreuve abandonnée" : ""}
      </span>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-10 hidden w-max max-w-52 group-hover:block group-focus-visible:block",
          align,
        )}
        style={{ bottom: `calc(${point.percent}% + 8px)` }}
      >
        <div className="border-border bg-card border px-2.5 py-1.5 text-left shadow-sm">
          <p className="text-[0.6875rem] leading-snug font-medium">{point.topicTitle}</p>
          <p className="mt-1 flex items-center gap-2">
            <ScoreTag score25={point.score25} />
            <span className="text-muted-foreground text-xs">{point.date}</span>
          </p>
          {point.outcome === "abandoned" && (
            <p className="text-muted-foreground mt-1 text-xs">Épreuve abandonnée</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Nothing to show yet.
 *
 * It names what does and does not reach the record. A sitting still in progress
 * is absent — there is nothing to say about it yet — while an abandoned one very
 * much is not, and saying so here is the same warning the exit dialog gives,
 * met before the candidate has anything to lose by it.
 */
function EmptyDashboard() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 text-center sm:px-6 sm:py-16">
      <span className="bg-primary-subtle text-primary mx-auto flex size-14 items-center justify-center rounded-lg">
        <MicIcon className="size-7" />
      </span>
      <h1 className="mt-5 font-serif text-2xl font-semibold">Aucune épreuve à votre actif</h1>
      <p className="text-muted-foreground mx-auto mt-3 max-w-[48ch] text-sm leading-relaxed">
        Passez une première production orale pour voir ici votre note sur {COMPETENCY_MAX}, votre
        trajectoire et votre temps de parole. Une épreuve en cours n&apos;apparaît pas encore ; une
        épreuve abandonnée, elle, compte comme une tentative notée 0.
      </p>
      <div className="mt-7">
        <Link href={HUB_LINKS.sujets} className={primaryButton}>
          Choisir un sujet
        </Link>
      </div>
    </main>
  );
}
