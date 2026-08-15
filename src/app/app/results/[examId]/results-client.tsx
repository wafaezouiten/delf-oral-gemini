"use client";

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import {
  ORAL_CRITERIA,
  ORAL_CRITERIA_COMPETENCE,
  ORAL_CRITERIA_LABELS,
} from "@/lib/delf/criteria";
import { BAND_LABELS, type GrilleBand } from "@/lib/delf/grille";
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
    latencySeconds: number;
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
      <main className="mx-auto w-full max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Résultat introuvable</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Ce résultat n&apos;est plus disponible dans cette session.
        </p>
        <Link
          href="/app"
          className="border-border mt-6 inline-block rounded-lg border px-4 py-2 text-sm font-semibold"
        >
          Passer une nouvelle épreuve
        </Link>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-16">
        <p className="text-muted-foreground text-sm">Chargement du résultat…</p>
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
      <p className="text-muted-foreground text-xs font-semibold tracking-[0.13em] uppercase">
        DELF B2 · Production orale
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{topic.title}</h1>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <section className="space-y-5">
          <div className="border-border bg-card rounded-xl border p-6">
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.13em] uppercase">
              Note globale
            </p>
            <p className="tabular mt-2 text-5xl font-semibold">
              {evaluation.score25}
              <span className="text-muted-foreground text-2xl"> / {COMPETENCY_MAX}</span>
            </p>
            <p
              className={`mt-3 inline-block rounded-full px-3 py-1 text-xs font-semibold ${
                passed ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"
              }`}
            >
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
            <dl className="text-muted-foreground mt-4 space-y-1 text-xs">
              <div className="flex justify-between">
                <dt>Monologue</dt>
                <dd className="tabular">{formatClock(monologueSeconds)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Débat</dt>
                <dd className="tabular">{formatClock(debateSeconds)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Évaluation</dt>
                <dd>
                  {evaluation.mode === "audio"
                    ? "audio + transcription"
                    : "transcription seule"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="border-border bg-card rounded-xl border p-6">
            <h2 className="text-sm font-semibold">Critères</h2>
            <ul className="mt-4 space-y-4">
              {ORAL_CRITERIA.map((key) => {
                const band = evaluation.criteria[key] ?? 0;
                return (
                  <li key={key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">{ORAL_CRITERIA_LABELS[key]}</span>
                      <span className="tabular text-sm font-semibold">{band} / 5</span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {ORAL_CRITERIA_COMPETENCE[key]} · {BAND_LABELS[band]}
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed">
                      {evaluation.feedback.justifications[key]}
                    </p>
                  </li>
                );
              })}
            </ul>
            {evaluation.feedback.phonologieNonEvaluable && (
              <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
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
            <BulletList items={evaluation.feedback.pointsForts} />
          </Panel>

          <Panel title="Axes prioritaires">
            <BulletList items={evaluation.feedback.axesPrioritaires} />
          </Panel>

          <Panel title="Conseil">
            <p className="text-sm leading-relaxed">{evaluation.feedback.conseil}</p>
          </Panel>

          <details className="border-border rounded-xl border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Transcription complète
            </summary>
            <pre className="text-muted-foreground mt-3 text-xs leading-relaxed whitespace-pre-wrap">
              {formatTranscript(transcript)}
            </pre>
          </details>
        </section>
      </div>

      <Link
        href="/app"
        className="border-border mt-8 inline-block rounded-lg border px-4 py-2 text-sm font-semibold"
      >
        Passer une nouvelle épreuve
      </Link>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-border bg-card rounded-xl border p-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">Rien à signaler.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="text-sm leading-relaxed">
          {item}
        </li>
      ))}
    </ul>
  );
}
