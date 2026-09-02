"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useSyncExternalStore } from "react";

import { Notice } from "@/app/_components/notice";
import { RecordingPlayer } from "@/app/_components/recording-player";
import { BandScale } from "@/app/_components/band-scale";
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
import { scoreInk } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { correctionNotices, earlyClosingNotice } from "@/lib/ui/correction-notices";
import { formatScore25 } from "@/lib/ui/format-score";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";
import {
  CORRECTION_TRANSCRIPT_COPY,
  PHASE_HEADINGS,
  correctionTranscriptView,
} from "@/lib/ui/correction-transcript";
import { speakerLabel, turnKey } from "@/lib/ui/debate-conversation";
import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_LABELS,
  ORAL_CRITERIA_SUMMARIES,
  type OralCriterion,
} from "@/lib/delf/criteria";
import { scoreTone, type GrilleBand } from "@/lib/delf/grille";
import { PHASE_DURATIONS, formatClock } from "@/lib/delf/phases";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";

/**
 * The correction, as one column on the fullscreen shell: the évaluation, and
 * the conversation under it.
 *
 * PORT NOTE: the reference's `OralResultReport` in `evaluation-resultats.tsx`. A
 * slim header (sujet · level · correction-IA pill · actions), a transcript
 * column reading as one printed page, and an evaluation rail — the /25 verdict
 * with its floor warning, the five criteria as collapsible rows grouped by
 * compétence, points forts / axes, the appréciation and one conseil.
 * Reproduced block for block, in that order — but no longer in the reference's
 * PLACES: #136 swapped the columns, on the user's call, and #183 stopped them
 * being columns at all. Everything inside each block is still the reference's.
 *
 * **One column, at every width (#183).** The two panes used to sit side by side
 * from `lg` up, each scrolling on its own, with a draggable separator between
 * them (#141) — so the correction and the transcript competed for the width and
 * for the reader, and neither had enough of either. Reading order settles it
 * instead: the évaluation first, whole, and the conversation below it. That is
 * what the phone always did and what the printed sheet always did; the desktop
 * now agrees with both, and the page has one scrollbar rather than three.
 *
 * The rail's whole apparatus went with it — the resize handle, the pointer
 * arithmetic, the observer that re-clamped a stored width against a resized
 * window, and `lib/ui/transcript-rail.ts`. None of it has a caller once there is
 * nothing to resize.
 *
 * Three things are this project's and stay:
 *
 *  - **`BandScale` replaces the reference's progress bar.** The reference draws
 *    a bar and a `3/5` chip; the official grid prints the whole 0 · 1 · 3 · 5
 *    scale with the awarded band ringed, so a candidate sees not just what they
 *    scored but what the next band up would have been. That is what this project
 *    already drew, it is more faithful to the épreuve than the bar, and it drops
 *    into the reference's collapsible row without changing its shape.
 *  - **The duration penalty, the two measured durations and the "corrigé sans
 *    l'audio" notice.** Facts this correction carries and the reference's never
 *    did, because it neither records nor times anything.
 *  - **"Recommencer" starts a NEW sitting.** The reference resets client state
 *    and re-runs the same conversation. A sitting here is a row with a
 *    correction in it; re-running one would overwrite a record that is already
 *    the candidate's. So it opens a fresh sitting — on the SAME sujet since
 *    #165, rather than sending the candidate back to the catalogue to find the
 *    card again. The word on the button is "again", and it now goes where it
 *    says.
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
   * correction renders exactly as it did before #98.
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
   * Two separate facts about the same number, and the reason the pill below did
   * not simply change colour.
   *
   * `passed` is the DELF's elimination rule and it is binary — 5/25 clears the
   * floor. `tone` is where the mark sits on the five-step scale, and 5/25 is in
   * the reddest band. « Au-dessus du seuil de 5/25 » in a rouge pill would read
   * as a contradiction, so the pill keeps the floor's own success/danger
   * treatment at full force and the band colours the numeral it describes (#50).
   */
  const tone = scoreTone(evaluation.score25);

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
   * `oral_exams`. It is what keeps `early_closing_count` from repeating
   * `reconnect_count`'s fate: a column persisted, passed all the way here, and
   * rendered nowhere.
   */
  const earlyClosing = earlyClosingNotice(result.earlyClosingCount);

  const phonoNote = evaluation.feedback.phonologieNonEvaluable
    ? "La phonologie n'a pas pu être évaluée de façon fiable sur cette production."
    : undefined;

  // `print:*` on both of this page's scroll containers — the shell, and the
  // column inside it. On screen the correction is a fixed-height pane that
  // scrolls, and a scroll container prints as one clipped screenful. Releasing
  // the clipping is what lets the sheet paginate at all — and therefore what
  // makes the section headings' `break-*` rules further down mean anything.
  //
  // Two rather than the four this took before #183, for the reason the layout
  // has one column rather than two: the grid and the rail were scroll
  // containers of their own, and each needed releasing separately or the half
  // carrying the /25 clipped while the other paginated.
  return (
    <div className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-hidden print:h-auto print:overflow-visible">
      {/* Header. `no-print` on the actions only: the correction is the thing a
          candidate keeps, so the sujet and the level stay on the printed sheet
          while the buttons do not. */}
      {/* Wraps below `sm` rather than truncating. The row carries the sujet, the
          level and the two ways on, and on a 375 px screen they do not fit a
          single 56 px band — the version that did hid the level, which is the
          one fact on this header a candidate cannot reconstruct from the rail
          below it. `min-h-14` keeps the desktop band exactly as it was. */}
      <header className="border-border bg-card z-20 flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 sm:flex-nowrap sm:px-5 sm:py-0">
        {/* « Retour », first in the row on both screens (#183). The correction
            is opened from three places — the finish, the historique and the
            tableau de bord — and until now the only way off it was
            « L'épreuve », which is not where any of those three are. It is an
            icon plus a word above `sm` and the icon alone below, which is the
            treatment « Mes notes » already uses in the passation's bar: the
            same 36 px target either way, and no wrap on a 375 px header that
            already carries the sujet and the level. */}
        <BackButton />
        <div className="min-w-0">
          <p className="truncate text-[0.84375rem] font-semibold">Production orale · Correction</p>
          <p className="text-muted-foreground truncate text-[0.6875rem]">{topic.title}</p>
        </div>
        <Tag className="shrink-0">DELF B2</Tag>
        <Tag className="hidden shrink-0 sm:inline-flex">
          {evaluation.mode === "audio" ? "Audio + transcription" : "Transcription seule"}
        </Tag>

        <div className="no-print flex shrink-0 items-center gap-2 sm:ml-auto">
          {/* Not a link (#165). It opens a NEW sitting on the sujet this
              correction is about, and opening one is a POST before it is a
              navigation — so this carries the pending state and the failure a
              link never had. See `useStartExam`.

              The clock it starts is said on `title` and on the accessible name,
              and nowhere visible. The sujet sheet had a footer to put that line
              in (#131); this header is a 56 px band that already wraps at `sm`
              and hid the level the last time something was added to it, and the
              consequence of a mistaken press here is recoverable — quitting
              before the exposé archives the sitting rather than spending it
              (#113). A dialog is what #131 removed, and it is not coming back
              for the button that says "again". */}
          <button
            type="button"
            onClick={() => void startExam(topic.slug)}
            disabled={starting}
            aria-label={`Recommencer : nouvelle épreuve sur le sujet « ${topic.title} ». La préparation (${PHASE_DURATIONS.preparation / 60} min) démarre dès l'ouverture.`}
            title={`Nouvelle épreuve sur le même sujet. La préparation (${PHASE_DURATIONS.preparation / 60} min) démarre dès l'ouverture.`}
            className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <RefreshIcon className="size-3.5" />
            {starting ? "Ouverture…" : "Recommencer"}
          </button>
          <Link
            href="/app"
            className="border-border bg-card hover:bg-muted inline-flex h-8 items-center rounded-md border px-4 text-xs font-semibold transition-colors"
          >
            L&apos;épreuve
          </Link>
        </div>
      </header>

      {/* Only when « Recommencer » fails, and below the band rather than inside
          it: the header is the one row this shell has no spare height in, and a
          message that appears on failure must not be the thing that reflows the
          sujet and the level when it does. */}
      {startError && (
        <p
          role="alert"
          className="no-print border-danger/40 bg-danger-subtle text-danger shrink-0 border-b px-4 py-2 text-xs leading-relaxed sm:px-5"
        >
          {startError}
        </p>
      )}

      {/* One column, and one scrollbar (#183): the évaluation, then the
          conversation. The order is the DOM's alone now — no grid, no
          breakpoint and no stored width — which is also the order the sheet
          prints in and the order a phone always showed. */}
      <div className="min-h-0 flex-1 overflow-y-auto print:overflow-visible">
        {/* The evaluation, first (#136). The /25 and the five criteria are what
            a candidate opens this page for. The centred measure is the
            treatment the transcript column established for a main pane; the
            verdict keeps its card so the mark still reads as the page's one
            headline. */}
        <section className="bg-muted/30">
          <div className="mx-auto max-w-[46rem] px-4 py-5 pb-8 sm:px-6">
            {/* Verdict */}
            <div className="border-border bg-card sheet border px-4 pt-4 pb-3.5 sm:px-5">
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
                {/* The verdict in a word as well as a colour — a candidate who
                  cannot tell the green pill from the red one still reads it. */}
                <Tag tone={passed ? "success" : "danger"}>
                  <span aria-hidden>{passed ? "✓" : "✕"}</span>
                  {passed
                    ? `Au-dessus du seuil de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX}`
                    : `Sous le seuil de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX}`}
                </Tag>
              </div>

              {/* Whole sentences, built and tested in `lib/ui/correction-notices.ts`.
                The component chooses neither the wording nor the figure: both
                depend on which rules fired, and the last version that decided
                the wording here told a candidate who sat neither part about
                « celle que vous avez réalisée ». */}
              {notices.absence && (
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                  {notices.absence}
                </p>
              )}

              {earlyClosing && (
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed">{earlyClosing}</p>
              )}

              {!passed && (
                <div className="border-danger/40 bg-danger-subtle text-danger mt-3 flex items-start gap-2.5 rounded-md border p-3">
                  <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="text-[0.71875rem] leading-snug">
                    Une note inférieure à {COMPETENCY_FLOOR}/{COMPETENCY_MAX} est éliminatoire au
                    DELF, quelle que soit la note globale.
                  </span>
                </div>
              )}
            </div>

            <RecordingsCard
              examId={examId}
              playable={result.playable ?? []}
              monologueSeconds={monologueSeconds}
              debateSeconds={debateSeconds}
            />

            {evaluation.mode === "text" && (
              <div className="mt-4">
                <Notice tone="warning" title="Corrigé sans l'audio">
                  Aucun enregistrement n&apos;a pu être joint à cette épreuve. La correction a été
                  faite à partir de la transcription seule : votre prononciation n&apos;a pas été
                  écoutée, et les durées affichées sont celles de l&apos;audio effectivement reçu.
                </Notice>
              </div>
            )}

            <div className="mt-5">
              {CRITERIA_GROUPS.map((group) => (
                <div key={group.competence} className="mb-3">
                  <Kicker className="text-[0.625rem]">{group.competence}</Kicker>
                  <div className="mt-2 flex flex-col gap-2">
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

              <FeedbackPanel
                tone="success"
                title="Points forts"
                marker="+"
                items={evaluation.feedback.pointsForts}
                emptyLabel="Aucun point fort identifié."
              />

              <div className="mt-2">
                <FeedbackPanel
                  tone="warning"
                  title="Axes prioritaires"
                  marker="→"
                  items={evaluation.feedback.axesPrioritaires}
                  emptyLabel="Rien à signaler, continuez ainsi."
                />
              </div>

              {evaluation.feedback.appreciationGlobale && (
                <div className="border-border bg-muted/40 sheet mt-2 border p-3.5">
                  <h3 className="text-xs font-bold">Appréciation globale</h3>
                  <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                    {evaluation.feedback.appreciationGlobale}
                  </p>
                </div>
              )}

              {evaluation.feedback.conseil && (
                <div className="border-primary/30 bg-primary-subtle sheet mt-2 flex items-start gap-2.5 border p-3.5">
                  <IdeaIcon className="text-primary mt-0.5 size-4 shrink-0" />
                  <p className="text-foreground/85 text-xs leading-relaxed">
                    <span className="text-primary font-semibold">Conseil : </span>
                    {evaluation.feedback.conseil}
                  </p>
                </div>
              )}

              {passed && (
                <p className="text-muted-foreground mt-3 flex items-center gap-2 px-1 text-[0.71875rem]">
                  <CheckCircleIcon className="text-success size-3.5 shrink-0" />
                  Note au-dessus du seuil éliminatoire du DELF ({COMPETENCY_FLOOR}/{COMPETENCY_MAX}
                  ).
                </p>
              )}

              {/* Provenance, at the foot of the evaluation and on the printed sheet:
                which model spoke and which one graded (#99). Raw ids on
                purpose — a readable label here would make two sittings on the
                same sujet quietly incomparable, which is the thing this line
                exists to prevent. The examiner is omitted rather than guessed
                on sittings from before it was recorded. */}
              <p className="text-muted-foreground border-border mt-4 border-t px-1 pt-3 text-[0.65625rem] leading-relaxed">
                {result.examinerModel && (
                  <>
                    Examinateur&nbsp;: <span className="tabular">{result.examinerModel}</span>
                    {" · "}
                  </>
                )}
                Correcteur&nbsp;: <span className="tabular">{evaluation.model}</span>
              </p>
            </div>
          </div>
        </section>

        {/* The conversation, under the correction (#183). Still whole and still
            printed — it lost the rail (#183) and then the players (#185), not
            the page. */}
        <TranscriptColumn
          title={topic.title}
          transcript={transcript}
          monologueSeconds={monologueSeconds}
          debateSeconds={debateSeconds}
        />
      </div>
    </div>
  );
}

/**
 * The transcript: the épreuve as it was spoken, set as one printed page — in
 * the two parts it was sat in (#70). It stood in the wide pane, then in the
 * fixed rail (#136), and since #183 it is simply the second half of one
 * column, under the correction. Nothing about its content, its print treatment
 * or its players changed at any of the three.
 *
 * The turns are paragraphs with a speaker label above them rather than the
 * reference's chat bubbles. Two reasons, and the second is the one that decides
 * it: this project has no chat primitives to reproduce them with, and a
 * transcript of a DELF oral is a document — the same thing the sujet is — so it
 * belongs on the paper stock the rest of the épreuve is printed on. The
 * reference's bubbles read as a messaging app, which is the one thing the
 * passation screen deliberately refuses to look like. **That holds for the débat
 * too**, now that it has a heading of its own: the same exchange is set as a
 * feed while it is happening (`debate-conversation.ts`) and as a record once it
 * is over, and only the sectioning changed here.
 *
 * Each turn is ruled down its left edge in its speaker's colour, with the name
 * set larger than the words it introduces (#87). The page is meant to be
 * scannable in one pass — who spoke reads before what they said — and two
 * voices are told apart more reliably by a line running the height of a turn
 * than by a colour on four small words. The rules are 2 px against the 1 px
 * hairlines that divide the sheet, which is the whole of the page's line
 * vocabulary: a hairline separates, a rule names. The gap between turns is
 * `space-y-5` rather than `space-y-4` for the same reason — at four, two
 * consecutive rules of the same colour close up into one long line and the
 * turns stop being separate.
 *
 * The examiner's rule takes `--muted-foreground` at full strength, the same
 * value its name does, and is not darkened to compensate for being the quiet
 * one: its label was quiet because 10 px capitals are quiet, whereas a 2 px
 * solid rule of that grey on the paper stock is 6.2:1, twice the 3:1 a non-text
 * mark needs. Both rules survive Ctrl+P, measured rather than assumed — they
 * are borders, not the background fills the print block flattens to white
 * (`globals.css`), so on paper the accent is 10.9:1 and print's darkened
 * `--muted-foreground` 9.7:1. A mono printer is the one place the *colours*
 * stop working and the rules do not: #1b3a7a and #444444 come out as greys 56
 * and 68 of 255, two firmly visible lines that are no longer two different
 * ones. Nothing is lost, because nothing was left to the colour — the speaker
 * is named in words above every turn, and on a greyscale sheet the rule's job
 * is to bound the turn rather than to name it.
 *
 * The head no longer carries « Monologue 7:02 · Débat 4:38 ». Each section now
 * prints its own duration beside its own heading, and leaving the combined line
 * up top would print both numbers twice.
 *
 * The players that sat on those heading lines are gone from here (#185): they
 * are one block up in the correction column, under the verdict. Still one
 * playback surface, as #116 left it — it moved rather than multiplied — and the
 * durations stay, because they are the transcript's own anchor for every
 * timestamp under them.
 *
 * Everything decided rather than drawn — the order, the headings, which
 * duration goes where, and which of the two "nothing was said" messages fires —
 * is in `lib/ui/correction-transcript.ts`, where it is tested.
 */
function TranscriptColumn({
  title,
  transcript,
  monologueSeconds,
  debateSeconds,
}: {
  title: string;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
}) {
  const { sections, silentNotice } = correctionTranscriptView(transcript, {
    monologueSeconds,
    debateSeconds,
  });

  return (
    <section className="border-border bg-muted/30 border-t">
      {/* The same 46 rem measure the correction above it is set in (#183), so
          the two halves of the column share one left margin instead of the
          transcript sitting 3.5 rem narrower than the block it now follows.
          The paddings stay the slim ones the rail forced (#136): they were
          right for a 420 px column and they are right for a centred measure —
          it is the sheet inside that carries the paper margin. */}
      <div className="mx-auto max-w-[46rem] px-4 py-5 pb-12 sm:px-6">
        <article className="border-paper-border bg-paper sheet border p-4 sm:p-5">
          <div className="border-border border-b pb-3">
            <Kicker>{CORRECTION_TRANSCRIPT_COPY.kicker}</Kicker>
          </div>

          <h2 className="mt-4 font-serif text-xl leading-tight font-semibold">{title}</h2>

          {silentNotice && (
            <div className="border-danger/40 bg-danger-subtle mt-5 rounded-md border border-dashed p-4">
              <p className="text-danger text-[0.8125rem] font-bold">{silentNotice.title}</p>
              <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                {silentNotice.body}
              </p>
            </div>
          )}

          {sections.map((section) => (
            <section key={section.phase} className="mt-7">
              {/* `break-after-avoid` and the heading row's `break-inside-avoid`:
                  a section heading that lands as the last line of a printed
                  page sends the candidate over the fold to find out which half
                  they are reading. The correction is the thing they keep, so
                  the heading travels with at least the start of its turns. */}
              <div className="border-border flex break-inside-avoid break-after-avoid flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-1.5">
                <h3 className="text-[0.8125rem] font-semibold">{section.heading}</h3>
                <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem]">
                  {section.durationLabel}
                </span>
              </div>

              {section.emptyNote ? (
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed italic">
                  {section.emptyNote}
                </p>
              ) : (
                <div className="mt-4 space-y-5">
                  {section.turns.map(({ entry, timeLabel }, index) => {
                    const isCandidate = entry.speaker !== "examiner";
                    /* One ternary for both classes: the rule and the name are
                       one decision, so repainting a speaker cannot leave its
                       rule behind on the old colour. Why these two colours, and
                       what they do on paper, is in the doc above. */
                    const tone = isCandidate
                      ? { rule: "border-primary", name: "text-primary" }
                      : { rule: "border-muted-foreground", name: "text-muted-foreground" };
                    return (
                      /* `break-inside-avoid` matters more here than it did on
                         the paragraph: a rule that crosses a page break prints
                         as two rules with a fold between them. A turn now
                         travels whole or not at all. */
                      <div
                        key={turnKey(entry, index)}
                        className={cn("break-inside-avoid border-l-2 pl-3", tone.rule)}
                      >
                        {/* The stamp shares the name's line rather than taking
                            one of its own: it is a locator, not a heading, and a
                            transcript where every turn costs three lines instead
                            of two reads as a log. `tabular` so the column of
                            stamps lines up down the page.

                            The name loses the capitals and the wide tracking on
                            its way up to `text-base`: small caps at 10 px read
                            as a label, the same capitals at 16 px read as
                            shouting. Only the name grows — the stamp keeps the
                            size it had, because it locates a turn rather than
                            introducing one. */}
                        <div className="flex items-baseline gap-2">
                          <span className={cn("text-base leading-tight font-medium", tone.name)}>
                            {speakerLabel(entry.speaker)}
                          </span>
                          <span className="text-muted-foreground/70 tabular text-[0.625rem] font-semibold">
                            {timeLabel}
                          </span>
                        </div>
                        <p className="mt-1 text-sm leading-relaxed">{entry.text}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ))}

          <p className="border-border text-muted-foreground mt-6 border-t pt-3 text-[0.6875rem] leading-relaxed">
            {CORRECTION_TRANSCRIPT_COPY.footnote}
          </p>
        </article>
      </div>
    </section>
  );
}

/**
 * « Vous réécouter » (#185): the two halves of the épreuve, as audio, in the
 * correction column.
 *
 * The players existed since #98 and were tucked beside each part's heading in
 * the transcript. That was the right place while the transcript held the wide
 * pane; it stopped being one when the correction became a single column (#183)
 * and the transcript moved below the whole évaluation — a candidate opening
 * their correction to listen back had to scroll past five criteria, two
 * feedback panels and the provenance line to find out whether there was
 * anything to listen to. They are one block now, under the verdict, where a
 * candidate looks.
 *
 * **One playback surface still** — the rule #116 set. The players are not in
 * two places; they moved.
 *
 * **A part with no kept audio says so.** Before, nothing rendered at all: a
 * sitting from before the vault, one whose upload failed, and one whose
 * recording the candidate deleted were indistinguishable from a page that had
 * simply not drawn them. The duration is still printed — it is the honest
 * record of a recording that existed — and the sentence beside it says the
 * audio itself is not available. A part with no audio AND no duration is a
 * part that was never spoken; the transcript's own quiet line covers that one,
 * so this card stays out of it.
 *
 * The whole card stands down when the sitting kept nothing at all, rather than
 * printing two apologies under a heading promising recordings.
 *
 * `no-print` like the players inside it: the correction prints as a grade
 * sheet, and audio has no printed form.
 */
function RecordingsCard({
  examId,
  playable,
  monologueSeconds,
  debateSeconds,
}: {
  examId: string;
  playable: ReadonlyArray<{
    phase: "monologue" | "debate";
    mimeType: string;
    durationSeconds: number;
  }>;
  monologueSeconds: number;
  debateSeconds: number;
}) {
  const seconds: Record<"monologue" | "debate", number> = {
    monologue: monologueSeconds,
    debate: debateSeconds,
  };

  // A part earns a row when there is audio to play OR audio there once was.
  // Both absent is a part that never happened, and the transcript says so.
  const rows = (["monologue", "debate"] as const)
    .map((phase) => ({
      phase,
      recording: playable.find((entry) => entry.phase === phase) ?? null,
      seconds: seconds[phase],
    }))
    .filter((row) => row.recording !== null || row.seconds > 0);

  if (rows.length === 0) return null;

  return (
    <section className="no-print border-border bg-card sheet mt-4 border">
      <div className="border-border flex items-baseline justify-between gap-3 border-b px-4 py-2.5 sm:px-5">
        <h2 className="text-[0.8125rem] font-bold">Vous réécouter</h2>
        <p className="text-muted-foreground text-[0.6875rem]">Audio de l&apos;épreuve</p>
      </div>
      <div className="divide-border divide-y">
        {rows.map((row) => (
          <div key={row.phase} className="px-4 py-3 sm:px-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-semibold">{PHASE_HEADINGS[row.phase]}</h3>
              <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem]">
                {formatClock(row.seconds)}
              </span>
            </div>
            {row.recording ? (
              <RecordingPlayer
                src={`/api/exams/${examId}/recordings/${row.phase}`}
                deleteHref={`/api/exams/${examId}/recordings/${row.phase}`}
                mimeType={row.recording.mimeType}
                durationSeconds={row.recording.durationSeconds}
                className="mt-2.5"
              />
            ) : (
              <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                L&apos;enregistrement de cette partie n&apos;est plus disponible : il a été
                supprimé, ou il n&apos;a pas pu être conservé. La durée ci-dessus reste celle de
                l&apos;audio réellement enregistré.
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
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
 * a correction opened in a fresh tab from a pasted or bookmarked url, where
 * `back()` leaves the browser sitting on the page it is already on. `length`
 * counts this session's entries in this tab, so 1 is exactly "arrived here
 * directly" — and the historique is the list this correction is one row of,
 * which is the nearest true answer to « retour » when there is no history to
 * read one from.
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
      className="no-print border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors sm:px-3"
    >
      <ArrowLeftIcon className="size-3.5" />
      <span className="hidden sm:inline">Retour</span>
    </button>
  );
}

/**
 * One criterion: a collapsible row carrying the grille's own scale, the /5, and
 * the model's justification behind the disclosure.
 *
 * Collapsed by default, one open at a time — the reference's behaviour. Five
 * justifications open at once is a wall of prose between the verdict and the
 * conversation below it, and the thing a candidate opens this page for is the
 * number.
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
  const low = band === 0;
  const panelId = `criterion-${label.replace(/\W+/g, "-").toLowerCase()}`;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        low ? "border-danger/40 bg-danger-subtle" : "border-border bg-card",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="hover:bg-muted/40 block w-full px-3.5 py-2.5 text-left transition-colors"
      >
        <span className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold">{label}</span>
          <ChevronDownIcon
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
        <span className="mt-2 block">
          <BandScale band={band} />
        </span>
      </button>

      <div id={panelId} hidden={!open} className="px-3.5 pb-2.5">
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

/** A strengths / next-steps panel. */
function FeedbackPanel({
  tone,
  title,
  marker,
  items,
  emptyLabel,
}: {
  tone: "success" | "warning";
  title: string;
  /** A character, so the two lists are told apart without colour. */
  marker: string;
  items: string[];
  emptyLabel: string;
}) {
  return (
    <div
      className={cn(
        "sheet border p-3.5",
        tone === "success"
          ? "border-success/30 bg-success-subtle/50"
          : "border-warning/40 bg-warning-subtle/50",
      )}
    >
      <h3 className={cn("text-xs font-bold", tone === "success" ? "text-success" : "text-warning")}>
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {items.length > 0 ? (
          items.map((item, index) => (
            <li
              key={index}
              className="text-foreground/85 flex items-start gap-2 text-xs leading-relaxed"
            >
              <span
                className={cn(
                  "shrink-0 font-bold",
                  tone === "success" ? "text-success" : "text-warning",
                )}
                aria-hidden
              >
                {marker}
              </span>
              {item}
            </li>
          ))
        ) : (
          <li className="text-muted-foreground text-xs">{emptyLabel}</li>
        )}
      </ul>
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
  action?: React.ReactNode;
}) {
  return (
    <main className="bg-background flex h-full items-center justify-center p-6">
      <div
        role={tone === "danger" ? "alert" : "status"}
        className="border-border bg-card sheet flex max-w-md flex-col items-center border px-8 py-14 text-center"
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
