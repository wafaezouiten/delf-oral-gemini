"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useExamController } from "@/lib/live/use-exam-controller";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import { PHASE_LABELS, MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import { isOpusEncodingSupported } from "@/lib/audio/opus-encoder";
import { selectDeliverable } from "@/lib/exams/uploaded-recording";
import type { OralTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { PhaseClock } from "./_components/phase-clock";
import { ConnectionBadge } from "./_components/connection-badge";
import { EventLog } from "./_components/event-log";
import { RecordingBadge } from "./_components/recording-badge";

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
   *
   * The recordings go up as one file per phase rather than one per sitting: the
   * duration floors are per task, and two artefacts are what lets a candidate
   * re-listen to the half that went wrong. Multipart because a 13-minute
   * recording has no business being base64'd into a JSON body.
   */
  const onFinished = useCallback(
    async (payload: ExamFinishedPayload) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      setSubmitError(null);

      const form = new FormData();
      const json = JSON.stringify({
        topicSlug: topic.slug,
        transcript: payload.transcript,
        phases: payload.phases,
        reconnectCount: payload.reconnectCount,
      });
      form.set("payload", json);

      /**
       * Weighed before it is sent, because the route refuses an oversized
       * upload with a 413 for the whole request and there is nothing here that
       * can recover from one: the exam is one-way, and a retry would re-send
       * the same bytes to be refused the same way (#24).
       *
       * A sitting encoded as Opus is about 2.4 MB and always fits, so in the
       * ordinary case this drops nothing. What it is for is the browser that
       * could not encode — where the artefact is a WAV, and a WAV is over the
       * per-file cap after 98 seconds.
       *
       * Dropping a recording costs the candidate more than phonologie: the
       * phase then measures zero seconds, and the duration penalty is computed
       * from measured audio. That is the same rule a dead microphone meets and
       * the only honest one available here — the server cannot grade audio it
       * was not given — but it is why this drops per artefact instead of
       * all-or-nothing, and why the briefing says so before the épreuve starts.
       */
      const deliverable = selectDeliverable(
        payload.recordings,
        (recording) => recording.blob.size,
        new TextEncoder().encode(json).length,
      );
      for (const recording of deliverable) {
        const extension = recording.mimeType === "audio/ogg" ? "ogg" : "wav";
        form.set(`audio-${recording.phase}`, recording.blob, `${recording.phase}.${extension}`);
      }
      for (const recording of payload.recordings) {
        if (deliverable.includes(recording)) continue;
        console.warn(
          `[finish] the ${recording.phase} recording is ${recording.blob.size} bytes, ` +
            `more than one request can carry as ${recording.mimeType}; ` +
            "that phase will be graded from its transcript and will measure zero seconds",
        );
      }

      // What the results page shows, and what the penalty was computed from: the
      // measured length of the recording, not the phase clock. They differ
      // exactly when something went wrong with the microphone, and showing the
      // clock there would hide it.
      const recordedSeconds = (phase: "monologue" | "debate") =>
        payload.phases.find((report) => report.phase === phase)?.recordedSeconds ?? 0;

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
            monologueSeconds: recordedSeconds("monologue"),
            debateSeconds: recordedSeconds("debate"),
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

  const { state, controller } = useExamController({ examId, topic, onFinished });

  /**
   * Whether this browser can compress the recording, asked before the épreuve
   * rather than discovered after it.
   *
   * A browser without WebCodecs archives a WAV, and a WAV sitting is far past
   * what one request may carry — so the recording is never sent and the
   * correction is made from the transcript alone (#24). That is a real loss of
   * the thing this product exists for, and the only moment the candidate can do
   * anything about it is now, before thirty minutes of preparation. Null while
   * the question is still being asked, so a slow answer does not flash a warning
   * at a browser that turns out to be fine.
   */
  const [canEncode, setCanEncode] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void isOpusEncodingSupported().then((supported) => {
      if (live) setCanEncode(supported);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!state.started) {
    return (
      <Briefing topic={topic} onStart={() => controller.start()} canEncode={canEncode} />
    );
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
              : // Not idle: the recordings are being compressed before they are
                // sent, which takes a few seconds for a full sitting.
                "Préparation de votre enregistrement…"}
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
          <RecordingBadge recording={state.recording} />
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

        {/* The candidate's way out of a dead session, and the reason the state
            machine treats `failed` as recoverable rather than terminal. Five
            automatic attempts can be spent by ten seconds of bad network in a
            twenty-minute exam; without this the only escape is reloading, which
            starts the épreuve over. Shown in every environment — it used to be
            folded into the development control below, which meant the documented
            recovery did not exist in production. */}
        {state.status === "error" && (
          <button
            type="button"
            onClick={() => void controller.forceReconnect()}
            className="bg-danger-subtle text-danger rounded-lg px-4 py-2 text-sm font-semibold"
          >
            Reprendre la connexion
          </button>
        )}

        {/* The same call, as a development affordance: it drives the path a real
            GoAway takes, so the 13-minute resumption behaviour can be exercised
            in seconds instead of waiting for the connection limit. Stands down
            once the real recovery control is on screen — two buttons doing the
            same thing side by side is how a developer ends up testing the wrong
            one. */}
        {process.env.NODE_ENV !== "production" &&
          state.phase !== "preparation" &&
          state.status !== "error" && (
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

function Briefing({
  topic,
  onStart,
  canEncode,
}: {
  topic: OralTopic;
  onStart: () => void;
  /** Null while the browser is still being asked. See `ExamClient`. */
  canEncode: boolean | null;
}) {
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
        Le microphone vous sera demandé au début du monologue, pas maintenant. Rien
        n&apos;est enregistré avant que vous ne l&apos;autorisiez : un témoin
        &laquo;&nbsp;Enregistrement&nbsp;&raquo; reste visible en haut de
        l&apos;écran pendant toute l&apos;épreuve. Vos deux prises de parole sont
        enregistrées séparément, puis envoyées pour la correction une fois
        l&apos;épreuve terminée. Utilisez un casque : sans lui,
        l&apos;examinateur s&apos;entend lui-même et la transcription en souffre.
      </p>

      {canEncode === false && (
        // Said here, and only here: after the épreuve the candidate can do
        // nothing about it, and the results page will only be able to report
        // that the correction was made without the audio.
        <p className="bg-danger-subtle text-danger rounded-lg px-4 py-3 text-xs leading-relaxed">
          Votre navigateur ne sait pas compresser l&apos;enregistrement, qui ne
          pourra donc pas être envoyé. Votre prestation sera corrigée à partir de
          la transcription seule, sans écoute de votre prononciation, et la
          pénalité de durée s&apos;appliquera comme si aucun enregistrement
          n&apos;existait. Passez plutôt l&apos;épreuve sur une version récente de
          Chrome, Edge, Safari ou Firefox.
        </p>
      )}

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
            // Verified against the live service: during a monologue nothing is
            // transcribed until the floor is released, so the whole exposé
            // arrives at once at the end. Saying so is better than showing an
            // empty panel for seven minutes and looking broken.
            <p className="text-muted-foreground text-sm">
              {phase === "monologue"
                ? "Votre enregistrement est en cours. La transcription de votre exposé s'affichera à la fin du monologue, en une seule fois."
                : "La transcription apparaîtra ici au fil de l'échange."}
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
