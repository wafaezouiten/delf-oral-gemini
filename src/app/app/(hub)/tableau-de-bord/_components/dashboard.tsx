import Link from "next/link";

import { primaryButton, secondaryButton } from "@/app/_components/button-styles";
import { ChartIcon, MicIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { scoreInk } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import type { DashboardView } from "@/lib/ui/dashboard-view";
import { SittingRow } from "../../_components/sitting-row";

/**
 * The tableau de bord, as pure presentation — no fetching, so it renders from a
 * view model alone.
 *
 * PORT NOTE: the reference's `/production-orale/tableau-de-bord` page body —
 * four stat tiles, a bar chart, a recent list, and an empty state that offers
 * the way to a first épreuve rather than an apology. All four reproduced.
 *
 * The chart's axis changed and `lib/ui/dashboard-view.ts` carries the argument:
 * the reference averages a /25 per DELF partie because a submission there IS one
 * partie, while a sitting here is the whole épreuve with one /25 — so the bars
 * are per criterion, which is the same shape fed by columns that exist.
 *
 * Split from the page so the arithmetic is unit-tested (`dashboard-view.test.ts`)
 * and the layout is renderable from fixtures. The reference keeps both in the
 * route file and pays for it by being unable to look at either without a
 * database and a signed-in user.
 */
export function Dashboard({ view }: { view: DashboardView }) {
  if (view.count === 0) return <EmptyDashboard />;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <Kicker>DELF B2 · Production orale</Kicker>
          <h1 className="mt-1 font-serif text-2xl leading-tight font-semibold">Tableau de bord</h1>
        </div>
        <Link href={HUB_LINKS.sujets} className={secondaryButton}>
          Nouvelle épreuve
        </Link>
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {view.tiles.map((tile) => (
          <li key={tile.key} className="border-border bg-card sheet border p-4">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              {tile.label}
            </p>
            {/* The one tile whose figure is a /25 is tinted on the /25 scale.
                The other three are a percentage, a duration and a day count,
                which are not marks and are left in the ink everything else is
                set in — tinting them would claim a 40 % pass rate was orange. */}
            <p
              className={cn(
                "tabular mt-2 font-serif text-3xl leading-none font-semibold",
                tile.band && scoreInk(tile.band.tone),
              )}
            >
              {tile.value}
            </p>
            <p className="text-muted-foreground mt-2 text-xs leading-snug">{tile.caption}</p>
          </li>
        ))}
      </ul>

      <section className="border-border bg-card sheet mt-6 border">
        <div className="rule-double flex items-center gap-2 px-6 py-4">
          <ChartIcon className="text-muted-foreground size-4" />
          <h2 className="font-serif text-base font-semibold">Moyenne par critère</h2>
        </div>
        <ul className="space-y-4 px-6 py-5">
          {view.criteria.map((row) => (
            <li key={row.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{row.label}</span>
                {/* The number beside the bar, always: a bar alone is a shape
                    somebody has to measure against its container to read. */}
                <span className="tabular shrink-0 font-semibold">{row.average} / 5</span>
              </div>
              <div className="bg-muted h-2 w-full overflow-hidden rounded-full" aria-hidden>
                <div
                  className="bg-primary h-full rounded-full"
                  style={{ width: `${row.percent}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground border-border border-t px-6 py-3 text-xs leading-relaxed">
          Moyenne sur {view.count} épreuve{view.count > 1 ? "s" : ""}, sur l&apos;échelle 0 · 1 · 3
          · 5 de la grille officielle. Une épreuve abandonnée compte pour 0 sur chaque critère.
        </p>
      </section>

      <section className="border-border bg-card sheet mt-6 border">
        <div className="rule-double flex flex-wrap items-baseline justify-between gap-3 px-6 py-4">
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
 * Nothing to show yet.
 *
 * It names what does and does not reach the record. A sitting still in progress
 * is absent — there is nothing to say about it yet — while an abandoned one very
 * much is not, and saying so here is the same warning the exit dialog gives,
 * met before the candidate has anything to lose by it.
 */
function EmptyDashboard() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
      <span className="bg-primary-subtle text-primary mx-auto flex size-14 items-center justify-center rounded-lg">
        <MicIcon className="size-7" />
      </span>
      <h1 className="mt-5 font-serif text-2xl font-semibold">Aucune épreuve à votre actif</h1>
      <p className="text-muted-foreground mx-auto mt-3 max-w-[48ch] text-sm leading-relaxed">
        Passez une première production orale pour voir ici votre note sur {COMPETENCY_MAX}, vos cinq
        critères et votre temps de parole. Une épreuve en cours n&apos;apparaît pas encore ; une
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
