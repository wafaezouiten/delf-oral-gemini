"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

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
import type { DurationCharge } from "@/lib/delf/orale-rubric";
import { cn } from "@/lib/ui/class-names";
import { correctionNotices, earlyClosingNotice } from "@/lib/ui/correction-notices";
import { formatScore25 } from "@/lib/ui/format-score";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import {
  RESULTS_RAIL_DEFAULT_PCT,
  RESULTS_RAIL_MAX_PCT,
  RESULTS_RAIL_MIN_PCT,
  clampRailPct,
  railPctAfterKey,
  railPctFromPointer,
} from "@/lib/ui/results-rail";
import { resultMetaLine, scoreToneLabel } from "@/lib/ui/score-verdict";
import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_LABELS,
  ORAL_CRITERIA_SUMMARIES,
  type OralCriterion,
} from "@/lib/delf/criteria";
import {
  BAND_LABELS,
  BAND_TONE,
  scoreTone,
  type BandTone,
  type GrilleBand,
} from "@/lib/delf/grille";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";
import { ResultsDrawer } from "./_components/results-drawer";
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

export interface StoredResult {
  evaluation: {
    mode: "text" | "audio";
    criteria: Record<string, GrilleBand>;
    rawScore25: number;
    score25: number;
    /**
     * What the rubric docked for a short épreuve, and which halves were short.
     *
     * Part of the stored payload and still computed, persisted and used by the
     * corrector — but nothing on this page renders either any more: the
     * « Note avant pénalité de durée » paragraph was removed on the user's
     * call (#137). Kept on the type because they describe what the stash and
     * the row actually carry, not what this page shows of them.
     */
    durationPenalty?: number;
    shortParts?: Array<"monologue" | "debate">;
    /** Where the duration charge landed, so the page can explain it (#189).
     *  Optional like the rest of the corrector's working: a stash written
     *  before the field existed carries nothing. */
    durationCharges?: DurationCharge[];
    /**
     * What the halving cost, and which part never happened. Optional for the
     * same reason as the two above, and the fallback matters more here: the
     * old reading would attribute 13 points to a short épreuve, which is not
     * what took them.
     */
    absencePenalty?: number;
    absentParts?: Array<"monologue" | "debate">;
    model: string;
    /**
     * Nullable because `evaluations.latency_seconds` is, and this object is
     * built from that row as well as from a fresh finish response. Nothing
     * renders it today; the type says `number | null` so that whatever renders
     * it next has to decide what an unmeasured correction looks like, instead of
     * inheriting a zero somebody coalesced to make the types line up.
     */
    latencySeconds: number | null;
    feedback: {
      justifications: Record<string, string>;
      appreciationGlobale: string;
      pointsForts: string[];
      axesPrioritaires: string[];
      conseil: string;
      phonologieNonEvaluable: boolean;
    };
  };
  topic: OralTopic;
  transcript: TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  reconnectCount: number;
  /**
   * How many times the examiner tried to close the épreuve mid-débat (#92).
   * Optional for the same reason `examinerModel` is: a stash from before the
   * field existed carries nothing, and a row from before the column reads 0.
   * Absent or zero, nothing renders — those corrections were graded by a
   * corrector that was never told, and the note would be false above them.
   */
  earlyClosingCount?: number;
  /**
   * The halves whose recording was kept and can be streamed back (#98), with
   * the mime type each was measured to be — the player needs it to ask the
   * browser `canPlayType` before offering a control that would only error.
   *
   * Optional because this object is also read back out of `sessionStorage`,
   * where a stash from before the field existed carries nothing — and because
   * the stash never carries it even now: the finish response holds no uris, so
   * playback belongs to the server-read path alone. Absent or empty, the
   * transcript renders its parts without players.
   */
  playable?: Array<{ phase: "monologue" | "debate"; mimeType: string; durationSeconds: number }>;
  /**
   * Which Live model played the examiner (#99). Optional for the same reason
   * `durationPenalty` is: this object also comes back out of `sessionStorage`,
   * where a sitting finished before the picker existed carries no such field.
   * Absent or null, the provenance line names the corrector alone.
   */
  examinerModel?: string | null;
}

/**
 * sessionStorage is an external store, so it is read with the API meant for
 * external stores rather than mirrored into state from an effect. The server
 * snapshot is `undefined` (there is no sessionStorage during SSR), which renders
 * the loading state and lets the client fill it in on hydration without a
 * mismatch.
 *
 * Parsing is memoised on the raw string so a re-render does not re-parse, and so
 * `getSnapshot` returns a stable identity as `useSyncExternalStore` requires.
 */
let parsedCache: { raw: string; value: StoredResult | null } | null = null;

function parseStored(raw: string | null): StoredResult | null | undefined {
  if (raw === null) return null;
  if (parsedCache?.raw === raw) return parsedCache.value;
  let value: StoredResult | null;
  try {
    value = JSON.parse(raw) as StoredResult;
  } catch {
    value = null;
  }
  parsedCache = { raw, value };
  return value;
}

/**
 * The five criteria in their two grille groups, in the grille's order.
 *
 * Derived from `ORAL_CRITERIA_COMPETENCE` rather than written out, so a
 * criterion that moves competence on the official grid moves here too. No
 * subtotals: the official grid prints one per competence, but this project's
 * rubric returns five bands and a total, and inventing the two intermediate sums
 * in a component would be computing data the earlier phase does not produce.
 *
 * Keyed by competence rather than by comparing against the previous group. A
 * run-length grouping would be correct by coincidence, printing the same
 * competence header twice the day somebody reorders the list — nothing would
 * fail, the grille would just quietly grow a sixth row of headings.
 */
const CRITERIA_GROUPS: ReadonlyArray<{
  competence: string;
  criteria: OralCriterion[];
}> = (() => {
  const groups = new Map<string, OralCriterion[]>();
  for (const criterion of ORAL_CRITERIA) {
    const competence = ORAL_CRITERIA_COMPETENCE[criterion];
    const existing = groups.get(competence);
    if (existing) existing.push(criterion);
    else groups.set(competence, [criterion]);
  }
  return [...groups].map(([competence, criteria]) => ({ competence, criteria }));
})();

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
    () => parseStored(sessionStorage.getItem(`delf-eval-${examId}`)),
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

  /** « Recommencer » (#165): a POST and then a navigation, not a link. */
  const { start: startExam, pending: starting, error: startError } = useStartExam();

  /**
   * The split body, which two things write CSS variables onto: the divider
   * writes `--po-rail` (the transcript rail's share of the split), the phone
   * drawer writes `--po-drawer-inset` (how much of the screen it covers). Both
   * go through the DOM rather than state — the divider reports on every
   * pointer frame of a drag, the drawer on every frame of its slide, and a
   * render per frame is what makes either stutter on a real machine. The ref
   * keeps the rail's current share for the keyboard path, which nudges
   * relatively.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const railHandleRef = useRef<HTMLDivElement>(null);
  const railPctRef = useRef(RESULTS_RAIL_DEFAULT_PCT);
  const railDragging = useRef(false);
  const setRailPct = useCallback((pct: number) => {
    const clamped = clampRailPct(pct);
    railPctRef.current = clamped;
    bodyRef.current?.style.setProperty("--po-rail", `${clamped}%`);
    // aria-valuenow written the same way as the width: the ARIA
    // window-splitter pattern wants the current split announced after every
    // arrow press, and a render per drag frame is exactly what this avoids.
    railHandleRef.current?.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }, []);
  const handleDrawerExposed = useCallback((height: number) => {
    bodyRef.current?.style.setProperty("--po-drawer-inset", `${height}px`);
  }, []);

  const result = initial ?? stashed;

  if (result === null) {
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

  if (!result) {
    return (
      <CentredCard
        tone="loading"
        title="Chargement du résultat…"
        body="La correction de cette épreuve est en cours de lecture."
      />
    );
  }

  const { evaluation, topic, transcript, monologueSeconds, debateSeconds } = result;
  const passed = meetsCompetencyFloor(evaluation.score25);

  /**
   * Two separate facts about the same number (#50). `passed` is the DELF's
   * elimination rule and it is binary — 5/25 clears the floor. `tone` is where
   * the mark sits on the five-step scale, and 5/25 is in the reddest band. The
   * pill names the band; the floor gets its own alert below, only when it is
   * breached (`scoreToneLabel` words that one case).
   */
  const tone = scoreTone(evaluation.score25);
  const meta = resultMetaLine({
    criteriaCount: ORAL_CRITERIA.length,
    totalSeconds: monologueSeconds + debateSeconds,
  });

  /**
   * The paragraph below the mark, built and tested in
   * `lib/ui/correction-notices.ts`. Only the halving speaks now: the duration
   * penalty still fires in the rubric, but its « Note avant pénalité de
   * durée » paragraph was removed on the user's call (#137).
   */
  const notices = correctionNotices(evaluation);

  /**
   * The examiner-fault note (#92) — the one sentence on this page keyed to the
   * sitting rather than to the correction, because the count lives on
   * `oral_exams`.
   */
  const earlyClosing = earlyClosingNotice(result.earlyClosingCount);

  const phonoNote = evaluation.feedback.phonologieNonEvaluable
    ? "La phonologie n'a pas pu être évaluée de façon fiable sur cette production."
    : undefined;

  /**
   * The pane's two halves, built ONCE and rendered twice — the aside from
   * `lg`, the drawer below it. Nodes rather than a duplicated block in each
   * branch, so the two copies cannot drift apart.
   */
  const verdict = (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <p
          className={cn(
            "tabular font-serif text-[2.875rem] leading-none font-semibold",
            scoreInk(tone),
          )}
        >
          {formatScore25(evaluation.score25)}
          <span className="text-muted-foreground text-[1.375rem] font-semibold">
            /{COMPETENCY_MAX}
          </span>
        </p>
        {/* The level in a word as well as a colour — a candidate who cannot
            tell the green pill from the red one still reads it. */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.71875rem] font-semibold",
            scorePill(tone),
          )}
        >
          <span className={cn("size-1.5 rounded-full", scoreFill(tone))} aria-hidden />
          {scoreToneLabel(evaluation.score25)}
        </span>
      </div>

      <p className="text-muted-foreground mt-2 text-xs">{meta}</p>

      {/* Whole sentences, built and tested in `lib/ui/correction-notices.ts`.
          The component chooses neither the wording nor the figure. */}
      {notices.absence && <VerdictNote>{notices.absence}</VerdictNote>}
      {notices.duration && <VerdictNote>{notices.duration}</VerdictNote>}
      {earlyClosing && <VerdictNote>{earlyClosing}</VerdictNote>}

      {evaluation.mode === "text" && (
        <div className="mt-3">
          <Notice tone="warning" title="Corrigé sans l'audio">
            Aucun enregistrement n&apos;a pu être joint à cette épreuve. La correction a été faite à
            partir de la transcription seule : votre prononciation n&apos;a pas été écoutée, et les
            durées affichées sont celles de l&apos;audio effectivement reçu.
          </Notice>
        </div>
      )}

      {!passed && (
        <div className="border-danger/40 bg-danger-subtle text-danger sheet mt-3 flex items-start gap-2.5 border p-3">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="text-[0.71875rem] leading-snug">
            Une note inférieure à {COMPETENCY_FLOOR}/{COMPETENCY_MAX} est éliminatoire au DELF,
            quelle que soit la note globale.
          </span>
        </div>
      )}
    </div>
  );

  const evaluationPane = (
    <>
      <div className="flex flex-col gap-4">
        {CRITERIA_GROUPS.map((group) => (
          <div key={group.competence}>
            <Kicker className="pb-2 text-[0.625rem]">{group.competence}</Kicker>
            <div className="flex flex-col gap-2">
              {group.criteria.map((key) => (
                <CriterionRow
                  key={key}
                  label={ORAL_CRITERIA_LABELS[key]}
                  description={ORAL_CRITERIA_SUMMARIES[key]}
                  band={evaluation.criteria[key] ?? 0}
                  justification={evaluation.feedback.justifications[key]}
                  note={key === "phonologie" ? phonoNote : undefined}
                  open={openKey === key}
                  onToggle={() => setOpenKey((current) => (current === key ? null : key))}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-2.5">
        <FeedbackPanel
          tone="success"
          title="Points forts"
          items={evaluation.feedback.pointsForts}
          emptyLabel="Aucun point fort identifié."
        />
        <FeedbackPanel
          tone="warning"
          title="Axes prioritaires"
          items={evaluation.feedback.axesPrioritaires}
          emptyLabel="Rien à signaler, continuez ainsi."
        />
        {evaluation.feedback.appreciationGlobale && (
          <AppreciationPanel text={evaluation.feedback.appreciationGlobale} />
        )}
        {evaluation.feedback.conseil && <ConseilPanel text={evaluation.feedback.conseil} />}
      </div>

      {passed && (
        <p className="text-muted-foreground mt-3 flex items-center gap-2 px-1 text-[0.71875rem]">
          <CheckCircleIcon className="text-success size-3.5 shrink-0" />
          Note au-dessus du seuil éliminatoire du DELF ({COMPETENCY_FLOOR}/{COMPETENCY_MAX}).
        </p>
      )}

      {/* Provenance, at the foot of the evaluation and on the printed sheet:
          which model spoke and which one graded (#99). Raw ids on purpose — a
          readable label here would make two sittings on the same sujet quietly
          incomparable. The examiner is omitted rather than guessed on sittings
          from before it was recorded. */}
      <p className="text-muted-foreground border-border mt-4 border-t px-1 pt-3 text-[0.65625rem] leading-relaxed">
        {result.examinerModel && (
          <>
            Examinateur&nbsp;: <span className="tabular">{result.examinerModel}</span>
            {" · "}
          </>
        )}
        Correcteur&nbsp;: <span className="tabular">{evaluation.model}</span>
      </p>
    </>
  );

  // `print:*` on every scroll container — the shell, the pane's scroller and
  // the transcript's. On screen each is a fixed-height box that scrolls, and a
  // scroll container prints as one clipped screenful; releasing the clip is
  // what lets the sheet paginate at all (#70). The grid falls back to blocks
  // so the evaluation prints first and the transcript under it, at any paper
  // width; the divider and the drawer have no printed form.
  return (
    <div className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-hidden print:h-auto print:overflow-visible">
      {/* Header. `no-print` on the actions only: the correction is the thing a
          candidate keeps, so the sujet and the level stay on the printed sheet
          while the buttons do not. Wraps below `sm` rather than truncating:
          the row carries the sujet, the level and the two ways on, and on a
          375 px screen they do not fit a single 56 px band. */}
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
            aria-label={`Recommencer : nouvelle épreuve sur le sujet « ${topic.title} ». La préparation (${PHASE_DURATIONS.preparation / 60} min) démarre dès l'ouverture.`}
            title={`Nouvelle épreuve sur le même sujet. La préparation (${PHASE_DURATIONS.preparation / 60} min) démarre dès l'ouverture.`}
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
            criterion rows past readability. */}
        <aside className="border-border bg-card hidden min-h-0 flex-col lg:flex lg:border-r print:flex print:border-r-0">
          <div className="border-border shrink-0 border-b px-5 pt-5 pb-4 sm:px-8">
            <div className="mx-auto w-full max-w-[47.5rem]">{verdict}</div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 print:overflow-visible">
            <div className="mx-auto w-full max-w-[47.5rem]">{evaluationPane}</div>
          </div>
        </aside>

        {/* The divider between the two panes, desktop only: dragging it (or
            arrow keys, once focused) resizes the transcript rail. An overlay
            centred on the panes' shared hairline rather than a third grid
            track, so the grid stays two columns; the visible line only paints
            on hover/focus — at rest the aside's own border is the divider. */}
        <div
          ref={railHandleRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner la transcription"
          aria-valuemin={RESULTS_RAIL_MIN_PCT}
          aria-valuemax={RESULTS_RAIL_MAX_PCT}
          aria-valuenow={RESULTS_RAIL_DEFAULT_PCT}
          tabIndex={0}
          onPointerDown={(event) => {
            // No text selection while dragging across the panes — and an
            // explicit focus, because `preventDefault` here swallows the
            // focus-on-click Safari would otherwise give it (#141).
            event.preventDefault();
            event.currentTarget.focus();
            railDragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!railDragging.current) return;
            const rect = bodyRef.current?.getBoundingClientRect();
            if (rect) setRailPct(railPctFromPointer(event.clientX, rect));
          }}
          onPointerUp={(event) => {
            railDragging.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => {
            railDragging.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home")
              return;
            event.preventDefault();
            setRailPct(railPctAfterKey(railPctRef.current, event.key));
          }}
          style={{ right: `var(--po-rail, ${RESULTS_RAIL_DEFAULT_PCT}%)` }}
          className={cn(
            "no-print absolute inset-y-0 z-10 hidden w-2.5 translate-x-1/2 cursor-col-resize touch-none outline-none select-none lg:block",
            "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-colors",
            "hover:after:bg-primary/40 focus-visible:after:bg-primary/60",
          )}
        />

        <TranscriptDocument
          examId={examId}
          title={topic.title}
          transcript={transcript}
          monologueSeconds={monologueSeconds}
          debateSeconds={debateSeconds}
          playable={result.playable ?? []}
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
        readout={`${formatScore25(evaluation.score25)}/${COMPETENCY_MAX}`}
        onExposedHeightChange={handleDrawerExposed}
        initiallyOpen
      >
        <div className="px-5 pt-1 pb-6">
          {verdict}
          <div className="mt-4">{evaluationPane}</div>
        </div>
      </ResultsDrawer>
    </div>
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
  label,
  description,
  band,
  justification,
  note,
  open,
  onToggle,
}: {
  label: string;
  description: string;
  band: GrilleBand;
  justification?: string;
  note?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const tone = BAND_CLASSES[BAND_TONE[band]];
  const low = band === 0;

  return (
    <div
      className={cn(
        "sheet relative overflow-hidden border",
        low ? "border-danger/40 bg-danger-subtle" : "border-border bg-card",
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
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold">{label}</span>
          <span className={cn("tabular shrink-0 text-xs font-semibold", tone.ink)}>{band}/5</span>
          {/* The band's name: a pill from `sm`, read but not shown below it —
              a phone's row has no width for a fourth word. */}
          <span
            className={cn(
              "hidden shrink-0 rounded-full px-2 py-0.5 text-[0.59375rem] font-semibold sm:inline-flex",
              tone.fill,
              tone.ink,
            )}
          >
            {BAND_LABELS[band]}
          </span>
          <span className="sr-only sm:hidden">{BAND_LABELS[band]}</span>
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
            style={{ width: `${(band / 5) * 100}%` }}
          />
        </span>
      </button>

      <div id={panelId} hidden={!open} className="px-3.5 pb-3">
        <p className="text-muted-foreground text-[0.71875rem] leading-relaxed">{description}</p>
        {justification && (
          <p className="border-border mt-2.5 border-t pt-2.5 text-xs leading-relaxed">
            {justification}
          </p>
        )}
        {note && (
          <div className="border-border text-muted-foreground mt-2.5 flex items-start gap-2 border-t pt-2.5">
            <AlertIcon className="mt-0.5 size-3 shrink-0" />
            <span className="text-[0.6875rem] leading-snug">{note}</span>
          </div>
        )}
      </div>
    </div>
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
