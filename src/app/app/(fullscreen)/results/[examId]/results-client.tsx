"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useId,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { Notice } from "@/app/_components/notice";
import { secondaryButton } from "@/app/_components/button-styles";
import { useStartExam } from "@/app/_components/use-start-exam";
import {
  AlertIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  IdeaIcon,
  RefreshIcon,
} from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import { scoreFill, scoreInk, scorePill } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import {
  resultsView,
  type CriterionRowView,
  type ResultsView,
  type TotalsView,
} from "@/lib/ui/results-view";
import { parseStoredResult, type StoredResult } from "@/lib/ui/stored-result";
import type { OralCriterion } from "@/lib/delf/criteria";
import type { BandTone } from "@/lib/delf/grille";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { ResultsDrawer } from "./_components/results-drawer";
import { ResultsRailDivider, useResultsRail } from "./_components/results-rail";
import { TranscriptDocument } from "./_components/transcript-document";

/**
 * The correction, as the main project's two-pane report on the fullscreen
 * shell (#190).
 *
 * PORT NOTE: `OralResultReport` in the main project's `evaluation-resultats.tsx`
 * (delf-preps@3901a2d6), block for block and now PLACE for place. A slim
 * header (sujet · level · « Correction IA » · actions); from `lg` a DOMINANT
 * evaluation pane on the left — the /25 verdict pinned at the top, then the
 * five criteria as collapsible rows grouped by compétence, points forts /
 * axes, the appréciation and one conseil, scrolling under it on a centred
 * measure — and the transcript in a right rail resting at 35 % of the split,
 * resizable by its divider; below `lg`, the transcript takes the whole screen
 * and the evaluation is a bottom drawer over it.
 *
 * **This reverses #183's one column, on the user's call.** That pass stacked
 * the évaluation over the conversation with one scrollbar, and deleted #141's
 * pixel-width rail with it. The main project's answer to the same complaint —
 * two panes competing for the width — was not to stack them but to make the
 * correction the dominant pane and let the reader set the rail: on a
 * correction, reading a justification against the sentence it judges IS the
 * task, and a page where the two are a screen apart makes the reader pay for
 * every comparison. The rail is in percent this time (`lib/ui/results-rail.ts`),
 * not #141's rem floor; the drawer is `_components/results-drawer.tsx`.
 *
 * What the pane holds is the main project's, on this project's tokens: the
 * `/25` in serif on the band's ink with a pill naming the level reached
 * (`lib/ui/score-verdict.ts`) and a meta line under it; each criterion as a
 * row carrying its `n/5`, the band's name and a bar on the band's tone —
 * which replaces the 0 · 1 · 3 · 5 `BandScale` this page drew from #11 to
 * #185, deleted with it; the feedback panels with tone kickers and dot
 * bullets. And three things are this project's and stay: « Retour », because
 * this page is opened from three places (#183); « Recommencer » as a POST on
 * the same sujet (#165); the halving, the examiner-fault note and the
 * corrigé-sans-l'audio notice, facts this correction carries and the main
 * project's never did, set under the verdict in the main project's own notice
 * shape.
 *
 * The verdict and the evaluation are built once as nodes and rendered in the
 * aside AND in the drawer — both are in the document, one hidden by width.
 * They share `openKey`, so one criterion is open at a time on either surface,
 * and every row's disclosure id comes from `useId`, so the two copies never
 * collide.
 */

export function ResultsClient({
  examId,
  initial,
}: {
  examId: string;
  /** The correction as stored, when the sitting was persisted and read back on
   *  the server. Everything below is unchanged when it is absent: a sitting with
   *  no row still renders from what the finish response left in sessionStorage,
   *  which is the only copy that exists for it. */
  initial?: StoredResult;
}) {
  const getSnapshot = useCallback(
    () => parseStoredResult(sessionStorage.getItem(`delf-eval-${examId}`)),
    [examId],
  );

  // sessionStorage never changes while this page is open, so the subscription is
  // a no-op; the store API is used for its correct read semantics, not for
  // change notifications.
  const subscribe = useCallback(() => () => {}, []);

  // Hooks first, unconditionally, and the stored copy wins afterwards — the
  // stash is a fallback, not an alternative branch, and a conditional hook would
  // be the way this stops being true.
  const stashed = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const [openKey, setOpenKey] = useState<OralCriterion | null>(null);
  const { bodyRef, handleRef, onDrawerExposed, handlers } = useResultsRail();

  const result = initial ?? stashed;

  if (result === null) return <NotFound />;
  if (!result) return <Loading />;

  const { topic, transcript, monologueSeconds, debateSeconds } = result;

  /**
   * Everything the two panes print, decided in `lib/ui/results-view.ts` where
   * `node --test` reads it: the verdict, the notes under it, the five rows with
   * both their figures, whether the totals box prints, who is named at the
   * foot. Nothing below chooses a word or a figure.
   */
  const view = resultsView(result);

  // `print:*` on every scroll container — the shell, the pane's scroller and
  // the transcript's. On screen each is a fixed-height box that scrolls, and a
  // scroll container prints as one clipped screenful; releasing the clip is
  // what lets the sheet paginate at all (#70). The grid falls back to blocks
  // so the evaluation prints first and the transcript under it, at any paper
  // width; the divider and the drawer have no printed form.
  return (
    <div className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-hidden print:h-auto print:overflow-visible">
      <ResultsHeader topic={topic} />

      {/* The split body. From `lg` the evaluation pane is DOMINANT on the
          left and the transcript rests in a right rail at `--po-rail` (35 %,
          resizable by the divider). Below `lg` the transcript is the only
          child in flow — the aside is hidden and the drawer is `fixed`,
          outside the grid entirely. The explicit `minmax(0,1fr)` row is what
          bounds the panes' height so each scrolls inside itself. */}
      <div
        ref={bodyRef}
        className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_var(--po-rail,35%)] print:block"
      >
        {/* The evaluation pane, from `lg` up and on paper. First in the DOM so
            the reading and tab order match the visual order. Its content is
            centred on a 47.5 rem measure so a wide pane does not stretch the
            criterion rows past readability. The same two halves are rendered
            again in the drawer below — one definition, two places. */}
        <aside className="border-border bg-card hidden min-h-0 flex-col lg:flex lg:border-r print:flex print:border-r-0">
          <div className="border-border shrink-0 border-b px-5 pt-5 pb-4 sm:px-8">
            <div className="mx-auto w-full max-w-[47.5rem]">
              <Verdict view={view} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 print:overflow-visible">
            <div className="mx-auto w-full max-w-[47.5rem]">
              <EvaluationPane view={view} openKey={openKey} setOpenKey={setOpenKey} />
            </div>
          </div>
        </aside>

        <ResultsRailDivider ref={handleRef} {...handlers} />

        <TranscriptDocument
          examId={examId}
          title={topic.title}
          transcript={transcript}
          monologueSeconds={monologueSeconds}
          debateSeconds={debateSeconds}
          playable={view.playable}
          drawerInset
        />
      </div>

      {/* The phone's route to the same pane. The score leads, exactly as it
          does in the aside, and the handle's readout carries it once the
          reader closes the drawer — which is what lets it rest closed over the
          transcript without hiding the result. `initiallyOpen`: the évaluation
          is what finishing the épreuve asked for, so it is not put behind a
          gesture the candidate has to discover first. */}
      <ResultsDrawer
        label="Évaluation"
        readout={`${view.score25}/${view.outOf}`}
        onExposedHeightChange={onDrawerExposed}
        initiallyOpen
      >
        <div className="px-5 pt-1 pb-6">
          <Verdict view={view} />
          <div className="mt-4">
            <EvaluationPane view={view} openKey={openKey} setOpenKey={setOpenKey} />
          </div>
        </div>
      </ResultsDrawer>
    </div>
  );
}

function NotFound() {
  return (
    <CentredCard
      tone="danger"
      title="Résultat introuvable"
      body="Cette correction n'a pas été retrouvée. Elle n'a pas été enregistrée, ou elle a été ouverte depuis un autre navigateur que celui où l'épreuve a été passée."
      action={
        <Link href="/app/sujets" className={secondaryButton}>
          Passer une nouvelle épreuve
        </Link>
      }
    />
  );
}

function Loading() {
  return (
    <CentredCard
      tone="loading"
      title="Chargement du résultat…"
      body="La correction de cette épreuve est en cours de lecture."
    />
  );
}

/**
 * The slim header: sujet · level · « Correction IA » · the two ways on.
 * `no-print` on the actions only: the correction is the thing a candidate
 * keeps, so the sujet and the level stay on the printed sheet while the
 * buttons do not. Wraps below `sm` rather than truncating: on a 375 px screen
 * the row does not fit a single 56 px band.
 */
function ResultsHeader({ topic }: { topic: StoredResult["topic"] }) {
  /** « Recommencer » (#165): a POST and then a navigation, not a link. */
  const { start: startExam, pending: starting, error: startError } = useStartExam();
  const clock = `La préparation (${PHASE_DURATIONS.preparation / 60} min) démarre dès l'ouverture.`;

  return (
    <>
      <header className="border-border bg-card z-20 flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 sm:flex-nowrap sm:px-5 sm:py-0">
        <BackButton />
        {/* `flex-1` at every width: the title shrinks to leave the level its
            room on the first row, so the phone's header is two rows (title,
            then the actions) rather than three. */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.84375rem] font-semibold">Production orale · Résultats</p>
          <p className="text-muted-foreground truncate text-[0.6875rem]">{topic.title}</p>
        </div>
        <Tag className="shrink-0">DELF B2</Tag>
        {/* `max-sm:hidden`, not `hidden sm:inline-flex`: the pill's own
            `inline-flex` is a base utility too and wins the tie, so only a
            variant hides it. */}
        <Tag className="shrink-0 max-sm:hidden">
          <span className="bg-warning size-1.5 rounded-full" aria-hidden />
          Correction IA
        </Tag>

        <div className="no-print flex shrink-0 items-center gap-2 sm:ml-auto">
          {/* Not a link (#165). It opens a NEW sitting on the sujet this
              correction is about, and opening one is a POST before it is a
              navigation — so this carries the pending state and the failure a
              link never had. See `useStartExam`. The clock it starts is said
              on `title` and on the accessible name, and nowhere visible: a
              dialog is what #131 removed, and it is not coming back for the
              button that says "again". */}
          <button
            type="button"
            onClick={() => void startExam(topic.slug)}
            disabled={starting}
            aria-label={`Recommencer : nouvelle épreuve sur le sujet « ${topic.title} ». ${clock}`}
            title={`Nouvelle épreuve sur le même sujet. ${clock}`}
            className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <RefreshIcon className="size-3.5" />
            {starting ? "Ouverture…" : "Recommencer"}
          </button>
          <Link
            href="/app"
            className="border-border bg-card hover:bg-muted inline-flex h-8 items-center rounded-full border px-4 text-xs font-semibold transition-colors"
          >
            L&apos;épreuve
          </Link>
        </div>
      </header>

      {/* Only when « Recommencer » fails, and below the band rather than inside
          it: the header is the one row this shell has no spare height in. */}
      {startError && (
        <p
          role="alert"
          className="no-print border-danger/40 bg-danger-subtle text-danger shrink-0 border-b px-4 py-2 text-xs leading-relaxed sm:px-5"
        >
          {startError}
        </p>
      )}
    </>
  );
}

/** The /25, its band in a word, the meta line, and the sentences under them. */
function Verdict({ view }: { view: ResultsView }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <p
          className={cn(
            "tabular font-serif text-[2.875rem] leading-none font-semibold",
            scoreInk(view.tone),
          )}
        >
          {view.score25}
          <span className="text-muted-foreground text-[1.375rem] font-semibold">/{view.outOf}</span>
        </p>
        {/* The level in a word as well as a colour — a candidate who cannot
            tell the green pill from the red one still reads it. */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.71875rem] font-semibold",
            scorePill(view.tone),
          )}
        >
          <span className={cn("size-1.5 rounded-full", scoreFill(view.tone))} aria-hidden />
          {view.toneLabel}
        </span>
      </div>

      <p className="text-muted-foreground mt-2 text-xs">{view.meta}</p>

      {/* Whole sentences — the halving, the duration charge, the examiner's
          early goodbyes — in the order the view built them. */}
      {view.notes.map((note) => (
        <VerdictNote key={note}>{note}</VerdictNote>
      ))}

      {view.textMode && (
        <div className="mt-3">
          <Notice tone="warning" title="Corrigé sans l'audio">
            Aucun enregistrement n&apos;a pu être joint à cette épreuve. La correction a été faite à
            partir de la transcription seule : votre prononciation n&apos;a pas été écoutée, et les
            durées affichées sont celles de l&apos;audio effectivement reçu.
          </Notice>
        </div>
      )}

      {!view.passed && (
        <div className="border-danger/40 bg-danger-subtle text-danger sheet mt-3 flex items-start gap-2.5 border p-3">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="text-[0.71875rem] leading-snug">{view.floorNote}</span>
        </div>
      )}
    </div>
  );
}

/** The rows, the totals under them, the feedback, and the provenance line. */
function EvaluationPane({
  view,
  openKey,
  setOpenKey,
}: {
  view: ResultsView;
  openKey: OralCriterion | null;
  setOpenKey: Dispatch<SetStateAction<OralCriterion | null>>;
}) {
  // One criterion open at a time, on either surface: both copies of the pane
  // share the key, so opening a row in the drawer opens it in the aside too.
  const toggle = (key: OralCriterion) => setOpenKey((current) => (current === key ? null : key));

  return (
    <>
      <div className="flex flex-col gap-4">
        {view.groups.map((group) => (
          <div key={group.competence}>
            <Kicker className="pb-2 text-[0.625rem]">{group.competence}</Kicker>
            <div className="flex flex-col gap-2">
              {group.rows.map((row) => (
                <CriterionRow
                  key={row.key}
                  row={row}
                  open={openKey === row.key}
                  onToggle={() => toggle(row.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {view.totals && <TotalsBox totals={view.totals} />}

      <div className="mt-4 flex flex-col gap-2.5">
        <FeedbackPanel
          tone="success"
          title="Points forts"
          items={view.feedback.pointsForts}
          emptyLabel="Aucun point fort identifié."
        />
        <FeedbackPanel
          tone="warning"
          title="Axes prioritaires"
          items={view.feedback.axesPrioritaires}
          emptyLabel="Rien à signaler, continuez ainsi."
        />
        {view.feedback.appreciationGlobale && (
          <AppreciationPanel text={view.feedback.appreciationGlobale} />
        )}
        {view.feedback.conseil && <ConseilPanel text={view.feedback.conseil} />}
      </div>

      <FloorAndProvenance view={view} />
    </>
  );
}

/**
 * Where the five figures actually land — built only when they add up and
 * something happened between the rows and the mark; see the view.
 */
function TotalsBox({ totals }: { totals: TotalsView }) {
  const deducted = totals.deductions.length > 0;
  return (
    <div className="sheet border-border bg-card mt-4 border px-3.5 py-3">
      {deducted && <TotalRow label="Total des critères" value={totals.criteriaTotal} />}
      {totals.deductions.map((deduction) => (
        <TotalRow
          key={deduction.key}
          label={deduction.label}
          value={`−${deduction.points}`}
          muted
        />
      ))}
      <TotalRow label={totals.finalLabel} value={totals.final} strong={deducted} />
    </div>
  );
}

/**
 * The floor line, only when it is cleared (the breach is said under the mark),
 * and the provenance at the foot of the evaluation and on the printed sheet:
 * which model spoke and which one graded (#99).
 */
function FloorAndProvenance({ view }: { view: ResultsView }) {
  return (
    <>
      {view.passed && (
        <p className="text-muted-foreground mt-3 flex items-center gap-2 px-1 text-[0.71875rem]">
          <CheckCircleIcon className="text-success size-3.5 shrink-0" />
          {view.floorNote}
        </p>
      )}
      <p className="text-muted-foreground border-border mt-4 border-t px-1 pt-3 text-[0.65625rem] leading-relaxed">
        {view.provenance.examinerModel && (
          <>
            Examinateur&nbsp;: <span className="tabular">{view.provenance.examinerModel}</span>
            {" · "}
          </>
        )}
        Correcteur&nbsp;: <span className="tabular">{view.provenance.correctorModel}</span>
      </p>
    </>
  );
}

/**
 * A sentence under the verdict about this sitting in particular — the halving,
 * the examiner's early goodbyes. The main project's notice shape (its
 * `PartialNotice` and duration line): a small bordered panel in the neutral
 * tone, because these explain the mark rather than judge it.
 */
function VerdictNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-border bg-muted/40 text-foreground sheet mt-3 border p-3 text-[0.71875rem] leading-snug">
      {children}
    </p>
  );
}

/**
 * « Retour » (#183): back to wherever the candidate came from.
 *
 * `router.back()` and not a link, because there is no single page behind this
 * one — the correction is opened from the finish of an épreuve, from a row of
 * the historique and from the tableau de bord's « Dernières épreuves », and a
 * fixed href would be wrong two times in three. The passation is not among the
 * three: it navigates here with `replace`, so the entry this goes back to is
 * whatever opened the épreuve rather than the finished épreuve itself.
 *
 * The fallback is the historique, for the one arrival with nothing behind it:
 * a correction opened in a fresh tab from a pasted or bookmarked url. `length`
 * counts this session's entries in this tab, so 1 is exactly "arrived here
 * directly".
 */
function BackButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length <= 1) {
          router.push(HUB_LINKS.historique);
          return;
        }
        router.back();
      }}
      aria-label="Retour à la page précédente"
      className="no-print border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors sm:px-3"
    >
      <ArrowLeftIcon className="size-3.5" />
      <span className="hidden sm:inline">Retour</span>
    </button>
  );
}

/**
 * The band's classes for one criterion's row — the `n/5`, the name pill and
 * the bar. The tone comes from `grille.ts` (`BAND_TONE`); the only thing this
 * map owns is which token a tone paints with, and it is keyed by `BandTone` so
 * a tone added to the grille fails the build here rather than rendering grey.
 */
const BAND_CLASSES: Record<BandTone, { ink: string; fill: string; bar: string }> = {
  red: { ink: "text-band-red", fill: "bg-band-red-subtle", bar: "bg-band-red" },
  amber: { ink: "text-band-amber", fill: "bg-band-amber-subtle", bar: "bg-band-amber" },
  green: { ink: "text-band-green", fill: "bg-band-green-subtle", bar: "bg-band-green" },
  emerald: { ink: "text-band-emerald", fill: "bg-band-emerald-subtle", bar: "bg-band-emerald" },
};

/**
 * One criterion: a collapsible row carrying its name, the `n/5` and the band's
 * name on the band's tone, a bar filled to the band, and (expanded) what the
 * criterion asks, the corrector's justification and the phonologie caveat.
 *
 * PORT NOTE: the main project's `criterion-row.tsx`, on the four grille tones
 * rather than its three. The bar replaces the `BandScale` this page drew since
 * #11 — the whole 0 · 1 · 3 · 5 row with the awarded band ringed. The bar says
 * less than the scale did about what the next band up would have been, and
 * the name pill and the `n/5` say the rest; it is the main project's row, and
 * that is what #190 asked for.
 *
 * Collapsed by default, one open at a time. `relative` on the card so the
 * phone-only `sr-only` name anchors to the row and is clipped by it (#114).
 */
function CriterionRow({
  row,
  open,
  onToggle,
}: {
  row: CriterionRowView;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  // Everything the row says about where the criterion LANDED — its colour, its
  // band name, the length of its bar — reads the awarded band, because that is
  // the figure the mark was built from (#203). The view decided which; this
  // only maps the tone to classes.
  const tone = BAND_CLASSES[row.tone];

  return (
    <div
      className={cn(
        "sheet relative overflow-hidden border",
        row.low ? "border-danger/40 bg-danger-subtle" : "border-border bg-card",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="hover:bg-muted/40 block w-full px-3.5 py-3 text-left transition-colors"
      >
        <span className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold">{row.label}</span>
          {/* The two figures are shown, and SAID, separately: the visible pair
              reads « 5 → 1 » across two spans, so the spoken sentence is one
              `sr-only` span carrying both numbers itself rather than a fragment
              that only completes because of what happens to sit beside it. */}
          <span className="sr-only">{row.spoken}</span>
          {row.charged > 0 && (
            <span
              className="tabular text-muted-foreground shrink-0 text-xs font-semibold"
              aria-hidden
            >
              {row.earned} →
            </span>
          )}
          <span className={cn("tabular shrink-0 text-xs font-semibold", tone.ink)} aria-hidden>
            {row.awarded}/5
          </span>
          {/* The band's name: a pill from `sm`, read but not shown below it —
              a phone's row has no width for a fourth word. */}
          <span
            className={cn(
              "hidden shrink-0 rounded-full px-2 py-0.5 text-[0.59375rem] font-semibold sm:inline-flex",
              tone.fill,
              tone.ink,
            )}
          >
            {row.bandLabel}
          </span>
          <span className="sr-only sm:hidden">{row.bandLabel}</span>
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
        <span className="bg-muted mt-2.5 block h-1 overflow-hidden rounded-full" aria-hidden>
          <span
            className={cn("criterion-bar block h-full rounded-full", tone.bar)}
            style={{ width: `${row.barPercent}%` }}
          />
        </span>
      </button>

      <div id={panelId} hidden={!open} className="px-3.5 pb-3">
        <CriterionDetails row={row} />
      </div>
    </div>
  );
}

/**
 * What the row says once opened: the criterion's description, the corrector's
 * justification, the clock's arithmetic (#203) — said here because the
 * justification above it is about the EARNED band, and a reader who has just
 * been told the exposé was clear needs to know why the row reads lower — and
 * the phonology note.
 */
function CriterionDetails({ row }: { row: CriterionRowView }) {
  return (
    <>
      <p className="text-muted-foreground text-[0.71875rem] leading-relaxed">{row.description}</p>
      {row.justification && (
        <p className="border-border mt-2.5 border-t pt-2.5 text-xs leading-relaxed">
          {row.justification}
        </p>
      )}
      {row.chargeNote && (
        <p className="border-border text-muted-foreground mt-2.5 border-t pt-2.5 text-[0.6875rem] leading-snug">
          {row.chargeNote}
        </p>
      )}
      {row.note && (
        <div className="border-border text-muted-foreground mt-2.5 flex items-start gap-2 border-t pt-2.5">
          <AlertIcon className="mt-0.5 size-3 shrink-0" />
          <span className="text-[0.6875rem] leading-snug">{row.note}</span>
        </div>
      )}
    </>
  );
}

/**
 * One line of the footer under the criteria: a label and a figure, the figures
 * aligned on `tabular` so the column can actually be added up by eye (#203).
 *
 * `muted` is a deduction, `strong` the line the deductions arrive at. Neither is
 * a heading — the whole block is a statement of arithmetic, and a screen reader
 * meets it as the run of text it is.
 */
function TotalRow({
  label,
  value,
  muted,
  strong,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <p
      className={cn(
        "flex items-baseline justify-between gap-3 text-xs",
        muted && "text-muted-foreground",
        strong && "border-border mt-1.5 border-t pt-1.5 font-semibold",
      )}
    >
      <span>{label}</span>
      <span className="tabular shrink-0">{value}</span>
    </p>
  );
}

/**
 * The label voice inside a feedback panel. Not `Kicker`, whose muted ink is
 * fixed: `cn` joins rather than merges, so a tone passed through `className`
 * would win or lose by Tailwind's ordering rather than by intent.
 */
function PanelKicker({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h3 className={cn("text-[0.6875rem] font-semibold tracking-[0.16em] uppercase", className)}>
      {children}
    </h3>
  );
}

/**
 * A strengths / next-steps panel: a hairline-bordered panel in one tone, its
 * kicker in the tone's ink, dot bullets. The titles tell the two apart
 * without colour.
 */
function FeedbackPanel({
  tone,
  title,
  items,
  emptyLabel,
}: {
  tone: "success" | "warning";
  title: string;
  items: string[];
  emptyLabel: string;
}) {
  const success = tone === "success";
  return (
    <div
      className={cn(
        "sheet border p-4",
        success
          ? "border-success/30 bg-success-subtle/50"
          : "border-warning/40 bg-warning-subtle/50",
      )}
    >
      <PanelKicker className={success ? "text-success" : "text-warning"}>{title}</PanelKicker>
      <ul className="mt-2.5 space-y-2">
        {items.length > 0 ? (
          items.map((item, index) => (
            <li
              key={`${title}-${index}`}
              className="text-foreground/85 flex items-start gap-2.5 text-xs leading-relaxed"
            >
              <span
                className={cn(
                  "mt-[7px] size-1 shrink-0 rounded-full",
                  success ? "bg-success" : "bg-warning",
                )}
                aria-hidden
              />
              {item}
            </li>
          ))
        ) : (
          <li className="text-muted-foreground text-xs italic">{emptyLabel}</li>
        )}
      </ul>
    </div>
  );
}

/** The corrector's overall appréciation — neutral, since it is not a verdict. */
function AppreciationPanel({ text }: { text: string }) {
  return (
    <div className="border-border bg-muted/40 sheet border p-4">
      <PanelKicker className="text-muted-foreground">Appréciation globale</PanelKicker>
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{text}</p>
    </div>
  );
}

/** One actionable tip for the next passation. The only blue block in the pane. */
function ConseilPanel({ text }: { text: string }) {
  return (
    <div className="border-primary/30 bg-primary-subtle sheet flex items-start gap-2.5 border p-4">
      <IdeaIcon className="text-primary mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <PanelKicker className="text-primary">Conseil pour la prochaine passation</PanelKicker>
        <p className="text-foreground/85 mt-1.5 text-xs leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

/** The two states that are not a report: nothing found, and not read yet. */
function CentredCard({
  tone,
  title,
  body,
  action,
}: {
  tone: "danger" | "loading";
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <main className="bg-background flex h-full items-center justify-center p-6">
      <div
        role={tone === "danger" ? "alert" : "status"}
        className="border-border bg-card sheet flex max-w-md flex-col items-center border px-6 py-10 text-center"
      >
        {tone === "danger" && (
          <span className="bg-danger-subtle text-danger flex size-14 items-center justify-center rounded-full">
            <AlertIcon className="size-7" />
          </span>
        )}
        <h1 className="mt-5 font-serif text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </main>
  );
}
