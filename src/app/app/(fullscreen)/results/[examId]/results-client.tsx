"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";

import { Notice } from "@/app/_components/notice";
import { BandScale } from "@/app/_components/band-scale";
import { secondaryButton } from "@/app/_components/button-styles";
import {
  AlertIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  IdeaIcon,
  RefreshIcon,
} from "@/app/_components/po/icons";
import { Kicker, Tag } from "@/app/_components/po/tag";
import { scoreInk } from "@/app/_components/score-band";
import { cn } from "@/lib/ui/class-names";
import { correctionNotices } from "@/lib/ui/correction-notices";
import {
  CORRECTION_TRANSCRIPT_COPY,
  correctionTranscriptView,
} from "@/lib/ui/correction-transcript";
import { speakerLabel, turnKey } from "@/lib/ui/debate-conversation";
import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_DESCRIPTIONS,
  ORAL_CRITERIA_LABELS,
  type OralCriterion,
} from "@/lib/delf/criteria";
import { scoreTone, type GrilleBand } from "@/lib/delf/grille";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";

/**
 * The correction, as a two-column report on the fullscreen shell.
 *
 * PORT NOTE: the reference's `OralResultReport` in `evaluation-resultats.tsx`. A
 * slim header (sujet · level · correction-IA pill · actions), a LEFT transcript
 * column reading as one printed page, and a RIGHT evaluation rail — the /25
 * verdict with its floor warning, the five criteria as collapsible rows grouped
 * by compétence, points forts / axes, the appréciation and one conseil.
 * Reproduced block for block, in that order.
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
 *    the candidate's. So it goes to the catalogue.
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
     * Optional because this object is read back out of `sessionStorage`, so a
     * results page opened after a deploy can be showing a sitting graded before
     * it. The fallback below is the old reading — worth the two lines, since the
     * alternative is a blank penalty notice on somebody's finished exam.
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
   * The two paragraphs below the mark, and the figure each is measured
   * against. Both live in `lib/ui/correction-notices.ts`, which is where the
   * arithmetic can be tested — and it needs to be, because the duration
   * paragraph's baseline is no longer the sum of the bands whenever the
   * halving fired in front of it.
   */
  const notices = correctionNotices(evaluation);

  const phonoNote = evaluation.feedback.phonologieNonEvaluable
    ? "La phonologie n'a pas pu être évaluée de façon fiable sur cette production."
    : undefined;

  // `print:*` on all four of this page's scroll containers — the shell, the
  // grid, the transcript column and the rail. On screen the correction is a
  // fixed-height, independently-scrolling pair of columns, and a scroll
  // container prints as one clipped screenful. Releasing the clipping is what
  // lets the sheet paginate at all — and therefore what makes the section
  // headings' `break-*` rules further down mean anything.
  //
  // All four, not just the transcript's: the rail is the half carrying the /25,
  // so a page that paginates on one side and clips on the other loses the grade
  // rather than the words.
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
        <div className="min-w-0">
          <p className="truncate text-[0.84375rem] font-semibold">
            Production orale · Correction
          </p>
          <p className="text-muted-foreground truncate text-[0.6875rem]">{topic.title}</p>
        </div>
        <Tag className="shrink-0">DELF B2</Tag>
        <Tag className="hidden shrink-0 sm:inline-flex">
          {evaluation.mode === "audio" ? "Audio + transcription" : "Transcription seule"}
        </Tag>

        <div className="no-print flex shrink-0 items-center gap-2 sm:ml-auto">
          <Link
            href="/app/sujets"
            className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-xs font-semibold transition-opacity hover:opacity-90"
          >
            <RefreshIcon className="size-3.5" />
            Recommencer
          </Link>
          <Link
            href="/app"
            className="border-border bg-card hover:bg-muted inline-flex h-8 items-center rounded-md border px-4 text-xs font-semibold transition-colors"
          >
            L&apos;épreuve
          </Link>
        </div>
      </header>

      {/* Split body: the transcript reads, the rail marks. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_26.25rem] lg:overflow-hidden print:overflow-visible">
        <TranscriptColumn
          title={topic.title}
          transcript={transcript}
          monologueSeconds={monologueSeconds}
          debateSeconds={debateSeconds}
        />

        <aside className="border-border bg-card flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l">
          {/* Verdict */}
          <div className="border-border shrink-0 border-b px-6 pt-5 pb-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <p
                className={cn(
                  "font-serif tabular text-[2.875rem] leading-none font-semibold",
                  scoreInk(tone),
                )}
              >
                {evaluation.score25}
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

            {notices.duration && (
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                {notices.duration}
              </p>
            )}

            {!passed && (
              <div className="border-danger/40 bg-danger-subtle text-danger mt-3 flex items-start gap-2.5 rounded-md border p-3">
                <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="text-[0.71875rem] leading-snug">
                  Une note inférieure à {COMPETENCY_FLOOR}/{COMPETENCY_MAX} est
                  éliminatoire au DELF, quelle que soit la note globale.
                </span>
              </div>
            )}
          </div>

          {/* The rail scrolls on its own too, and it is the half carrying the
              /25 and the five criteria — the part of a printed correction it
              would hurt most to lose the foot of. Same release as the three on
              the shell. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 print:overflow-visible">
            {evaluation.mode === "text" && (
              <div className="mb-4">
                <Notice tone="warning" title="Corrigé sans l'audio">
                  Aucun enregistrement n&apos;a pu être joint à cette épreuve. La
                  correction a été faite à partir de la transcription seule :
                  votre prononciation n&apos;a pas été écoutée, et les durées
                  affichées sont celles de l&apos;audio effectivement reçu.
                </Notice>
              </div>
            )}

            {CRITERIA_GROUPS.map((group) => (
              <div key={group.competence} className="mb-4">
                <Kicker className="text-[0.625rem]">{group.competence}</Kicker>
                <div className="mt-2 flex flex-col gap-2">
                  {group.criteria.map((key) => (
                    <CriterionRow
                      key={key}
                      label={ORAL_CRITERIA_LABELS[key]}
                      description={ORAL_CRITERIA_DESCRIPTIONS[key]}
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

            <div className="mt-2.5">
              <FeedbackPanel
                tone="warning"
                title="Axes prioritaires"
                marker="→"
                items={evaluation.feedback.axesPrioritaires}
                emptyLabel="Rien à signaler, continuez ainsi."
              />
            </div>

            {evaluation.feedback.appreciationGlobale && (
              <div className="border-border bg-muted/40 mt-2.5 sheet border p-4">
                <h3 className="text-xs font-bold">Appréciation globale</h3>
                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                  {evaluation.feedback.appreciationGlobale}
                </p>
              </div>
            )}

            {evaluation.feedback.conseil && (
              <div className="border-primary/30 bg-primary-subtle mt-2.5 flex items-start gap-2.5 sheet border p-4">
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
                Note au-dessus du seuil éliminatoire du DELF ({COMPETENCY_FLOOR}/
                {COMPETENCY_MAX}).
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * The left column: the épreuve as it was spoken, set as one printed page — in
 * the two parts it was sat in (#70).
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
 * The head no longer carries « Monologue 7:02 · Débat 4:38 ». Each section now
 * prints its own duration beside its own heading, and leaving the combined line
 * up top would print both numbers twice.
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
    <section className="bg-muted/30 min-h-0 lg:overflow-y-auto print:overflow-visible">
      <div className="mx-auto max-w-[42.5rem] px-4 py-6 pb-16 sm:px-7">
        <article className="border-paper-border bg-paper sheet border p-7 sm:p-9">
          <div className="border-border border-b pb-3">
            <Kicker>{CORRECTION_TRANSCRIPT_COPY.kicker}</Kicker>
          </div>

          <h2 className="font-serif mt-4 text-xl leading-tight font-semibold">{title}</h2>

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
              <div className="border-border flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-1.5 break-inside-avoid break-after-avoid">
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
                <div className="mt-4 space-y-4">
                  {section.turns.map(({ entry, timeLabel }, index) => {
                    const isCandidate = entry.speaker !== "examiner";
                    return (
                      <p
                        key={turnKey(entry, index)}
                        className="text-sm leading-relaxed break-inside-avoid"
                      >
                        {/* The stamp shares the label's line rather than taking
                            one of its own: it is a locator, not a heading, and a
                            transcript where every turn costs three lines instead
                            of two reads as a log. `tabular` so the column of
                            stamps lines up down the page. */}
                        <span className="flex items-baseline gap-2 text-[0.625rem] font-semibold tracking-[0.16em] uppercase">
                          <span className={isCandidate ? "text-primary" : "text-muted-foreground"}>
                            {speakerLabel(entry.speaker)}
                          </span>
                          <span className="text-muted-foreground/70 tabular tracking-normal">
                            {timeLabel}
                          </span>
                        </span>
                        {entry.text}
                      </p>
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
 * One criterion: a collapsible row carrying the grille's own scale, the /5, and
 * the model's justification behind the disclosure.
 *
 * Collapsed by default, one open at a time — the reference's behaviour. Five
 * justifications open at once is a wall of prose in a 420 px rail, and the thing
 * a candidate opens this page for is the number.
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
        className="hover:bg-muted/40 block w-full px-3.5 py-3 text-left transition-colors"
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
        <span className="mt-2.5 block">
          <BandScale band={band} />
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
        "sheet border p-4",
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
        className="border-border bg-card flex max-w-md flex-col items-center sheet border px-8 py-14 text-center"
      >
        {tone === "danger" && (
          <span className="bg-danger-subtle text-danger flex size-14 items-center justify-center rounded-full">
            <AlertIcon className="size-7" />
          </span>
        )}
        <h1 className="font-serif mt-5 text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </main>
  );
}
