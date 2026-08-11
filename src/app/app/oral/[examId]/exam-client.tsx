"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useExamController } from "@/lib/live/use-exam-controller";
import { PHASE_LABELS, MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import type { OralTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { PhaseClock } from "./_components/phase-clock";
import { ConnectionBadge } from "./_components/connection-badge";
import { EventLog } from "./_components/event-log";

/**
 * The exam screen. One component per phase, so each phase's UI is genuinely its
 * own and not a pile of conditionals inside a shared layout.
 *
 * The controller owns all the behaviour; this file only renders what phase the
 * exam is in.
 */
export function ExamClient({ examId, topic }: { examId: string; topic: OralTopic }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittedRef = useRef(false);

  /**
   * Ship the finished exam for grading. The evaluation is stashed in
   * sessionStorage as well as persisted, so the results page renders even with
   * no database configured.
   */
  const onFinished = useCallback(
    async (payload: {
      transcript: TranscriptEntry[];
      audio: Blob | null;
      monologueSeconds: number;
      debateSeconds: number;
      reconnectCount: number;
    }) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      setSubmitError(null);

      const form = new FormData();
      form.set(
        "payload",
        JSON.stringify({
          topicSlug: topic.slug,
          transcript: payload.transcript,
          monologueSeconds: payload.monologueSeconds,
          debateSeconds: payload.debateSeconds,
          reconnectCount: payload.reconnectCount,
        }),
      );
      if (payload.audio) form.set("audio", payload.audio, "candidate.wav");

      try {
        const response = await fetch(`/api/exams/${examId}/finish`, {
          method: "POST",
          body: form,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Évaluation impossible");

        sessionStorage.setItem(
          `delf-eval-${examId}`,
          JSON.stringify({
            evaluation: body.evaluation,
            topic,
            transcript: payload.transcript,
            monologueSeconds: payload.monologueSeconds,
            debateSeconds: payload.debateSeconds,
            reconnectCount: payload.reconnectCount,
          }),
        );
        router.push(`/app/results/${examId}`);
      } catch (error) {
        console.error(error);
        setSubmitError(
          error instanceof Error ? error.message : "L'évaluation a échoué.",
        );
        setSubmitting(false);
        // Allow a retry: the transcript is still in memory.
        submittedRef.current = false;
      }
    },
    [examId, topic, router],
  );

  const { state, controller } = useExamController({ topic, onFinished });

  if (!state.started) {
    return <Briefing topic={topic} onStart={() => controller.start()} />;
  }

  if (state.phase === "finished") {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold">Épreuve terminée</h1>
        <p className="text-muted-foreground text-sm">
          {submitting
            ? "Votre prestation est en cours d'évaluation. Cela peut prendre une minute."
            : submitError
              ? submitError
              : "Redirection vers vos résultats…"}
        </p>
        {submitError && (
          <button
            type="button"
            onClick={() => router.push("/app")}
            className="border-border rounded-lg border px-4 py-2 text-sm font-semibold"
          >
            Retour au tableau de bord
          </button>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.13em] uppercase">
            {PHASE_LABELS[state.phase]}
          </p>
          <h1 className="mt-0.5 text-lg font-semibold">{topic.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {state.phase !== "preparation" && <ConnectionBadge state={state.connection} />}
          <PhaseClock remaining={state.remaining} phase={state.phase} />
        </div>
      </header>

      {state.micError && (
        <p className="bg-danger-subtle text-danger rounded-lg px-4 py-3 text-sm">
          {state.micError}
        </p>
      )}

      {state.phase === "preparation" && (
        <PreparationPanel topic={topic} notes={notes} onNotes={setNotes} />
      )}

      {(state.phase === "monologue" || state.phase === "debate") && (
        <SpeakingPanel
          phase={state.phase}
          examinerSpeaking={state.examinerSpeaking}
          transcript={state.transcript}
          notes={notes}
        />
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => void controller.advanceEarly()}
          disabled={!state.canAdvance}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {advanceLabel(state.phase, state.elapsed)}
        </button>

        {/* The forced-reconnect control from §16. Kept visible in development
            only: it drives the same path a real GoAway takes, so the 13-minute
            resumption behaviour can be tested in seconds. */}
        {process.env.NODE_ENV !== "production" && state.phase !== "preparation" && (
          <button
            type="button"
            onClick={() => void controller.forceReconnect()}
            className="border-border text-muted-foreground rounded-lg border px-3 py-1.5 text-xs font-semibold"
          >
            Forcer une reconnexion ({state.reconnectCount})
          </button>
        )}
      </footer>

      {process.env.NODE_ENV !== "production" && <EventLog events={state.events} />}
    </main>
  );
}

function advanceLabel(phase: string, elapsed: number): string {
  if (phase === "preparation") return "Je suis prêt, commencer le monologue";
  if (phase === "monologue") {
    return elapsed < MONOLOGUE_MIN_SECONDS
      ? `Monologue en cours (minimum ${Math.ceil((MONOLOGUE_MIN_SECONDS - elapsed) / 60)} min)`
      : "Terminer le monologue et passer au débat";
  }
  return "Terminer l'épreuve";
}

function Briefing({ topic, onStart }: { topic: OralTopic; onStart: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-3">
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.13em] uppercase">
          Avant de commencer
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{topic.title}</h1>
      </div>

      <ol className="text-muted-foreground space-y-2 text-sm leading-relaxed">
        <li>1. 30 minutes de préparation. Vous pouvez prendre des notes.</li>
        <li>
          2. Monologue suivi de 5 à 7 minutes. L&apos;examinateur écoute sans vous
          interrompre.
        </li>
        <li>
          3. Débat d&apos;environ 13 minutes. L&apos;examinateur conteste votre
          position ; défendez-la.
        </li>
        <li>4. Évaluation sur 25 points selon la grille officielle.</li>
      </ol>

      <p className="bg-muted text-muted-foreground rounded-lg px-4 py-3 text-xs leading-relaxed">
        Le microphone vous sera demandé au début du monologue, pas maintenant.
        Utilisez un casque : sans lui, l&apos;examinateur s&apos;entend lui-même et
        la transcription en souffre.
      </p>

      <button
        type="button"
        onClick={onStart}
        className="bg-primary text-primary-foreground self-start rounded-lg px-5 py-2.5 text-sm font-semibold"
      >
        Commencer la préparation
      </button>
    </main>
  );
}

function PreparationPanel({
  topic,
  notes,
  onNotes,
}: {
  topic: OralTopic;
  notes: string;
  onNotes: (value: string) => void;
}) {
  return (
    <div className="grid flex-1 gap-4 md:grid-cols-[1.4fr_1fr]">
      <section className="border-border bg-card rounded-xl border p-5">
        <h2 className="text-sm font-semibold">Document déclencheur</h2>
        <p className="mt-3 text-sm leading-relaxed">{topic.document}</p>
        <h3 className="mt-6 text-sm font-semibold">Consigne</h3>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {topic.consigne}
        </p>
      </section>

      <section className="border-border bg-card flex flex-col rounded-xl border p-5">
        <h2 className="text-sm font-semibold">Vos notes</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Elles resteront visibles pendant votre monologue.
        </p>
        <textarea
          value={notes}
          onChange={(event) => onNotes(event.target.value)}
          placeholder="Introduction, thèse, arguments, exemples, conclusion…"
          className="border-border mt-3 min-h-64 flex-1 resize-none rounded-lg border bg-transparent p-3 text-sm leading-relaxed outline-none"
        />
      </section>
    </div>
  );
}

function SpeakingPanel({
  phase,
  examinerSpeaking,
  transcript,
  notes,
}: {
  phase: "monologue" | "debate";
  examinerSpeaking: boolean;
  transcript: readonly TranscriptEntry[];
  notes: string;
}) {
  const entries = transcript.filter((entry) => entry.phase === phase);

  return (
    <div className="grid flex-1 gap-4 md:grid-cols-[1.4fr_1fr]">
      <section className="border-border bg-card flex flex-col rounded-xl border p-5">
        <div className="flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${examinerSpeaking ? "bg-primary" : "bg-success"}`}
            aria-hidden
          />
          <h2 className="text-sm font-semibold">
            {examinerSpeaking
              ? "L'examinateur parle, écoutez."
              : phase === "monologue"
                ? "Vous avez la parole. L'examinateur ne vous interrompra pas."
                : "À vous de répondre."}
          </h2>
        </div>

        <div className="mt-4 flex-1 space-y-3 overflow-y-auto text-sm leading-relaxed">
          {entries.length === 0 && (
            <p className="text-muted-foreground text-sm">
              La transcription apparaîtra ici au fil de la parole.
            </p>
          )}
          {entries.map((entry, index) => (
            <p key={`${entry.timestamp}-${index}`}>
              <span
                className={`text-xs font-semibold tracking-[0.13em] uppercase ${
                  entry.speaker === "examiner" ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {entry.speaker === "examiner" ? "Examinateur" : "Vous"}
              </span>
              <br />
              {entry.text}
            </p>
          ))}
        </div>
      </section>

      <section className="border-border bg-card rounded-xl border p-5">
        <h2 className="text-sm font-semibold">Vos notes</h2>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed whitespace-pre-wrap">
          {notes.trim() || "Aucune note prise pendant la préparation."}
        </p>
      </section>
    </div>
  );
}
