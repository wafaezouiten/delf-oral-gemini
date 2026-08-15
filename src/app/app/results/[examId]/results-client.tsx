"use client";

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";

import { Notice } from "@/app/_components/notice";
import { BandScale } from "@/app/_components/band-scale";
import { secondaryButton } from "@/app/_components/button-styles";
import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_DESCRIPTIONS,
  ORAL_CRITERIA_LABELS,
  type OralCriterion,
} from "@/lib/delf/criteria";
import { type GrilleBand } from "@/lib/delf/grille";
import { meetsCompetencyFloor } from "@/lib/delf/orale-rubric";
import { formatClock } from "@/lib/delf/phases";
import { formatTranscript, type TranscriptEntry } from "@/lib/delf/transcript";
import type { OralTopic } from "@/lib/delf/topics";

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
 * rubric returns five bands and a total, and inventing the two intermediate
 * sums in a component would be exactly the "computing data the earlier phase
 * does not produce" that #11 rules out.
 *
 * Computed once at module load rather than per render. The cost is nothing at
 * five criteria; what it buys is the statement — this depends on two module
 * constants and nothing about a particular correction, and a future reader
 * looking for where the grouping reacts to a prop will not go hunting.
 *
 * Keyed by competence rather than by comparing against the previous group. The
 * difference only shows up if `ORAL_CRITERIA` ever stops listing same-competence
 * criteria contiguously — today it does, and a run-length grouping would have
 * been correct by coincidence, printing the same competence header twice the
 * day somebody reorders the list. Nothing would have failed; the grille would
 * just have quietly grown a sixth row of headings. A `Map` is correct whatever
 * the order, and groups still appear in the order their competence is first
 * met, which keeps the criteria in the grille's own sequence.
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

/**
 * @param initial The correction as it is stored, when the sitting was persisted
 *   and read back on the server (Phase 8). Everything below is unchanged when it
 *   is absent: a sitting with no row — no database, a degraded `local-…` id, a
 *   write that failed — still renders from what the finish response left in
 *   `sessionStorage`, which is the only copy that exists for it.
 */
export function ResultsClient({
  examId,
  initial,
}: {
  examId: string;
  initial?: StoredResult;
}) {
  const getSnapshot = useCallback(
    () => parseStored(sessionStorage.getItem(`delf-eval-${examId}`)),
    [examId],
  );

  // sessionStorage never changes while this page is open, so the subscription
  // is a no-op; the store API is used for its correct read semantics, not for
  // change notifications.
  const subscribe = useCallback(() => () => {}, []);

  // Hooks first, unconditionally, and the stored copy wins afterwards — the
  // stash is a fallback, not an alternative branch, and a conditional hook would
  // be the way this stops being true.
  const stashed = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const result = initial ?? stashed;
  const missing = result === null;

  if (missing) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-16">
        <h1 className="font-serif text-center text-xl font-semibold">
          Résultat introuvable
        </h1>
        <p className="text-muted-foreground mt-2 text-center text-sm leading-relaxed">
          Cette correction n&apos;a pas été retrouvée. Elle n&apos;a pas été
          enregistrée, ou elle a été ouverte depuis un autre navigateur que celui
          où l&apos;épreuve a été passée.
        </p>
        <div className="mt-6 text-center">
          <Link href="/app" className={secondaryButton}>
            Passer une nouvelle épreuve
          </Link>
        </div>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-16">
        <p className="text-muted-foreground text-sm" role="status">
          Chargement du résultat…
        </p>
      </main>
    );
  }

  const { evaluation, topic, transcript, monologueSeconds, debateSeconds } = result;
  const passed = meetsCompetencyFloor(evaluation.score25);
  const penalised =
    evaluation.durationPenalty !== undefined
      ? evaluation.durationPenalty > 0
      : evaluation.score25 < evaluation.rawScore25;

  /** Which half fell short, in the candidate's own words. */
  const shortParts = evaluation.shortParts ?? [];
  const shortLabel =
    shortParts.length === 2
      ? "vos deux prises de parole ont été"
      : shortParts[0] === "monologue"
        ? "votre monologue a été"
        : shortParts[0] === "debate"
          ? "votre débat a été"
          : "votre temps de parole a été";

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="border-border border-b pb-5">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale · Correction
        </p>
        <h1 className="font-serif mt-1 text-2xl leading-tight font-semibold text-balance">
          {topic.title}
        </h1>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <section className="space-y-5">
          <div className="border-border bg-card rounded-lg border p-6">
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              Note globale
            </p>
            <p className="font-serif tabular mt-2 text-6xl leading-none font-semibold">
              {evaluation.score25}
              <span className="text-muted-foreground text-2xl"> / {COMPETENCY_MAX}</span>
            </p>
            {/* The verdict in a word as well as a colour — a candidate who cannot
                tell the green pill from the red one still reads « Au-dessus ». */}
            <p
              className={`mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-semibold ${
                passed
                  ? "border-success/30 bg-success-subtle text-success"
                  : "border-danger/40 bg-danger-subtle text-danger"
              }`}
            >
              <span aria-hidden>{passed ? "✓" : "✕"}</span>
              {passed
                ? `Au-dessus du seuil de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX}`
                : `En dessous du seuil de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX}`}
            </p>
            {penalised && (
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                Note avant pénalité de durée : {evaluation.rawScore25}/{COMPETENCY_MAX}.{" "}
                {/* Named, not merely announced: "vous avez été pénalisé" is an
                    assertion, "votre débat a duré 40 secondes" is something the
                    candidate can check against the clock beside it. */}
                {shortLabel} nettement plus court que ce que demande l&apos;épreuve réelle.
              </p>
            )}
            <dl className="text-muted-foreground border-border mt-4 space-y-1 border-t pt-4 text-xs">
              <div className="flex justify-between gap-4">
                <dt>Monologue</dt>
                <dd className="tabular">{formatClock(monologueSeconds)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Débat</dt>
                <dd className="tabular">{formatClock(debateSeconds)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Évaluation</dt>
                <dd>
                  {evaluation.mode === "audio"
                    ? "audio + transcription"
                    : "transcription seule"}
                </dd>
              </div>
            </dl>
          </div>

          {/* The two degraded corrections, told plainly rather than left as a
              word in the table above. Both are states the earlier phases can
              genuinely produce — a browser that could not encode, a recording
              too large to send, a microphone that died — and a /25 that was
              reached without hearing the candidate should say so. */}
          {evaluation.mode === "text" && (
            <Notice tone="warning" title="Corrigé sans l'audio">
              Aucun enregistrement n&apos;a pu être joint à cette épreuve. La
              correction a été faite à partir de la transcription seule : votre
              prononciation n&apos;a pas été écoutée, et les durées ci-dessus sont
              celles de l&apos;audio effectivement reçu.
            </Notice>
          )}

          <div className="border-border bg-card rounded-lg border">
            <h2 className="border-border font-serif border-b px-6 py-4 text-base font-semibold">
              Grille de correction
            </h2>
            {CRITERIA_GROUPS.map((group) => (
              <div key={group.competence} className="border-border border-b last:border-b-0">
                <h3 className="text-muted-foreground bg-muted/60 px-6 py-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                  {group.competence}
                </h3>
                <ul className="divide-border divide-y">
                  {group.criteria.map((key) => {
                    const band = evaluation.criteria[key] ?? 0;
                    return (
                      <li key={key} className="space-y-2 px-6 py-4">
                        <div className="flex items-baseline justify-between gap-3">
                          <h4 className="text-sm font-semibold">
                            {ORAL_CRITERIA_LABELS[key]}
                          </h4>
                          <span className="tabular text-sm font-semibold whitespace-nowrap">
                            {band} / 5
                          </span>
                        </div>
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {ORAL_CRITERIA_DESCRIPTIONS[key]}
                        </p>
                        <BandScale band={band} />
                        <p className="text-sm leading-relaxed">
                          {evaluation.feedback.justifications[key]}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {evaluation.feedback.phonologieNonEvaluable && (
              <p className="text-muted-foreground border-border border-t px-6 py-4 text-xs leading-relaxed">
                La phonologie n&apos;a pas pu être évaluée de façon fiable sur cette
                production.
              </p>
            )}
          </div>
        </section>

        <section className="space-y-5">
          <Panel title="Appréciation globale">
            <p className="text-sm leading-relaxed">
              {evaluation.feedback.appreciationGlobale}
            </p>
          </Panel>

          <Panel title="Points forts">
            <BulletList items={evaluation.feedback.pointsForts} marker="+" tone="text-success" />
          </Panel>

          <Panel title="Axes prioritaires">
            <BulletList
              items={evaluation.feedback.axesPrioritaires}
              marker="→"
              tone="text-warning"
            />
          </Panel>

          <Panel title="Conseil">
            <p className="text-sm leading-relaxed">{evaluation.feedback.conseil}</p>
          </Panel>

          <details className="border-border bg-card rounded-lg border">
            <summary className="cursor-pointer px-6 py-4 text-sm font-semibold">
              Transcription complète
            </summary>
            <pre className="text-muted-foreground border-border max-h-96 overflow-y-auto border-t px-6 py-4 font-sans text-xs leading-relaxed whitespace-pre-wrap">
              {formatTranscript(transcript)}
            </pre>
          </details>
        </section>
      </div>

      <div className="no-print mt-8">
        <Link href="/app" className={secondaryButton}>
          Passer une nouvelle épreuve
        </Link>
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-border bg-card rounded-lg border">
      <h2 className="border-border font-serif border-b px-6 py-4 text-base font-semibold">
        {title}
      </h2>
      <div className="px-6 py-4">{children}</div>
    </div>
  );
}

function BulletList({
  items,
  marker,
  tone,
}: {
  items: string[];
  /** A character rather than a bullet, so the two lists are told apart without
   *  colour: strengths are marked `+`, next steps `→`. */
  marker: string;
  tone: string;
}) {
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">Rien à signaler.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5 text-sm leading-relaxed">
          <span className={`shrink-0 font-bold ${tone}`} aria-hidden>
            {marker}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
