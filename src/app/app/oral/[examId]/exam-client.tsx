"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Notice } from "@/app/_components/notice";
import { dangerButton, primaryButton, secondaryButton } from "@/app/_components/button-styles";
import { useExamController } from "@/lib/live/use-exam-controller";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import { PHASE_LABELS, MONOLOGUE_MIN_SECONDS } from "@/lib/delf/phases";
import { isOpusEncodingSupported } from "@/lib/audio/opus-encoder";
import { selectDeliverable } from "@/lib/exams/uploaded-recording";
import { describeFinishFailure, type FinishFailure } from "@/lib/ui/finish-failure";
import type { OralTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { PhaseClock } from "./_components/phase-clock";
import { PhaseSteps } from "./_components/phase-steps";
import { ConnectionBadge } from "./_components/connection-badge";
import { EventLog } from "./_components/event-log";
import { RecordingBadge } from "./_components/recording-badge";
import { SubjectDocument } from "./_components/subject-document";

/**
 * The exam screen. One component per phase, so each phase's UI is genuinely its
 * own and not a pile of conditionals inside a shared layout.
 *
 * The controller owns all the behaviour; this file only renders what phase the
 * exam is in.
 */
/**
 * How long the briefing waits for the browser to say whether it can encode.
 *
 * `AudioEncoder.isConfigSupported` answers in milliseconds; this is only here so
 * that one that never answers costs the candidate three seconds rather than the
 * épreuve.
 */
const BROWSER_CHECK_TIMEOUT_MS = 3_000;

const PHASE_LABEL_FR: Record<"monologue" | "debate", string> = {
  monologue: "monologue",
  debate: "débat",
};

export function ExamClient({ examId, topic }: { examId: string; topic: OralTopic }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FinishFailure | null>(null);
  const submittedRef = useRef(false);

  /**
   * The phases whose recording could not be attached to the finish request.
   *
   * Rendered rather than only logged, which is the whole point: #11 asks that a
   * candidate can go from start to correction without reading a console, and
   * "your débat was graded from the transcript and measured zero seconds" is
   * exactly the kind of thing that used to live in a `console.warn` nobody
   * opens. Said on this screen, at the moment it happens, because the results
   * page is read back from the database and this is not a fact the database
   * holds.
   */
  const [droppedPhases, setDroppedPhases] = useState<Array<"monologue" | "debate">>([]);

  /**
   * The finished sitting, kept so the upload can be retried.
   *
   * `submittedRef` is already reset when a finish fails — the controller's
   * payload is the only thing that was missing, and without it the retry the
   * comment there promises had no way to be offered. The audio lives in this
   * tab and nowhere else, so this ref is the last copy of the épreuve; it is not
   * cleared on success only because the screen navigates away.
   */
  const finishedPayload = useRef<ExamFinishedPayload | null>(null);

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
      finishedPayload.current = payload;
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
      const dropped: Array<"monologue" | "debate"> = [];
      for (const recording of payload.recordings) {
        if (deliverable.includes(recording)) continue;
        dropped.push(recording.phase);
        // Deliberately not "too large": a recording is also dropped when it is
        // legal on its own and the pair is not, and a triage message that names
        // the wrong limit sends the reader to the wrong constant.
        console.warn(
          `[finish] the ${recording.phase} recording (${recording.blob.size} bytes, ` +
            `${recording.mimeType}) was not attached: it does not fit in one request ` +
            "beside the rest of the sitting. That phase will be graded from its " +
            "transcript and will measure zero seconds.",
        );
      }
      setDroppedPhases(dropped);

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
        // A platform error is an HTML page, not this route's JSON, so parsing is
        // allowed to fail without losing the status — which is the half of the
        // failure that decides whether a retry is worth offering.
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          setSubmitError(describeFinishFailure(response.status, body?.error));
          setSubmitting(false);
          submittedRef.current = false;
          return;
        }

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
        // The request never got an answer — offline, DNS, a dropped upload. The
        // exception's own words ("Failed to fetch") are for the console; the
        // candidate gets a sentence and a retry, because nothing was refused.
        console.error(error);
        setSubmitError(describeFinishFailure(null, null));
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
   * what one request may carry — so the recording is never sent, the correction
   * is made from the transcript alone, and the duration penalty applies as if
   * nothing had been recorded (#24). That is the whole product lost, and the
   * only moment the candidate can do anything about it is now, before thirty
   * minutes of preparation.
   *
   * Which is why the épreuve does not start until the question has been
   * answered. `isConfigSupported` is fast, but "fast" is not "synchronous": a
   * candidate who clicks straight through on a slow device would take the
   * briefing — and with it the only warning there will ever be — off screen
   * before it could render, and `Briefing` does not come back.
   *
   * The timeout is the other half of that. A browser that never answers must
   * not hold the exam shut, so the wait is bounded; past it the sitting starts
   * unwarned, which is exactly where this began and no worse.
   */
  const [canEncode, setCanEncode] = useState<boolean | null>(null);
  const [checkingBrowser, setCheckingBrowser] = useState(true);
  useEffect(() => {
    let live = true;
    const settle = (supported: boolean | null) => {
      if (!live) return;
      if (supported !== null) setCanEncode(supported);
      setCheckingBrowser(false);
    };

    void isOpusEncodingSupported().then(settle);
    const timer = setTimeout(() => settle(null), BROWSER_CHECK_TIMEOUT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  if (!state.started) {
    return (
      <Briefing
        topic={topic}
        onStart={() => controller.start()}
        canEncode={canEncode}
        checking={checkingBrowser}
      />
    );
  }

  if (state.phase === "finished") {
    return (
      <FinishedScreen
        submitting={submitting}
        submitError={submitError}
        droppedPhases={droppedPhases}
        onRetry={() => {
          const payload = finishedPayload.current;
          if (payload) void onFinished(payload);
        }}
        onLeave={() => router.push("/app")}
      />
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              {PHASE_LABELS[state.phase]}
            </p>
            <h1 className="font-serif mt-0.5 truncate text-xl leading-tight font-semibold">
              {topic.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RecordingBadge recording={state.recording} />
            {state.phase !== "preparation" && <ConnectionBadge state={state.connection} />}
            <PhaseClock remaining={state.remaining} phase={state.phase} />
          </div>
        </div>
        <PhaseSteps current={state.phase} />
      </header>

      {/* Every failure the épreuve can produce, in the order a candidate cares
          about it: the connection that has stopped coming back, then the
          microphone. Both are messages first and a control second — a red button
          on its own is not an explanation. */}
      {state.status === "error" && (
        <Notice
          tone="danger"
          title="La connexion avec l'examinateur est perdue"
          action={
            <button
              type="button"
              onClick={() => void controller.forceReconnect()}
              className={dangerButton}
            >
              Reprendre la connexion
            </button>
          }
        >
          Les tentatives automatiques de reconnexion n&apos;ont pas abouti. Le temps
          de cette partie continue de s&apos;écouler et ce qui a déjà été dit est
          conservé. Vérifiez votre connexion internet, puis reprenez.
        </Notice>
      )}

      {state.micError && (
        <Notice tone="warning" title="Microphone">
          {state.micError}
        </Notice>
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
          className={primaryButton}
        >
          {advanceLabel(state.phase, state.elapsed)}
        </button>

        {/* Drives the path a real GoAway takes, so the 13-minute resumption
            behaviour can be exercised in seconds instead of waiting for the
            connection limit. Stands down once the real recovery control is on
            screen in the notice above — two buttons doing the same thing side by
            side is how a developer ends up testing the wrong one. */}
        {process.env.NODE_ENV !== "production" &&
          state.phase !== "preparation" &&
          state.status !== "error" && (
            <button
              type="button"
              onClick={() => void controller.forceReconnect()}
              className="border-border text-muted-foreground rounded-md border px-3 py-1.5 text-xs font-semibold"
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

/**
 * The end of the épreuve, which is three states and not one.
 *
 * Compressing, then either a correction on its way or a failure to send. The
 * third is the one worth writing carefully: the audio exists only in this tab,
 * so the message says so and the retry is offered before the way out — a
 * candidate who reads "retour au tableau de bord" first and clicks it has thrown
 * away twenty minutes of recording.
 */
function FinishedScreen({
  submitting,
  submitError,
  droppedPhases,
  onRetry,
  onLeave,
}: {
  submitting: boolean;
  submitError: FinishFailure | null;
  droppedPhases: Array<"monologue" | "debate">;
  onRetry: () => void;
  onLeave: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 py-16">
      <div className="text-center">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          DELF B2 · Production orale
        </p>
        <h1 className="font-serif mt-1 text-2xl font-semibold">Épreuve terminée</h1>
        {/* A live region only while there is no failure. Once `submitError` is
            set, this paragraph's text changes at the same moment the assertive
            <Notice> below mounts, and a screen reader would receive two
            overlapping statements about one event — the same fault the
            connection badge was silenced for. The notice wins here for the same
            reason it wins there: it is the one carrying the explanation and the
            button. The sentence stays on screen; it just stops announcing. */}
        <p
          className="text-muted-foreground mt-2 text-sm leading-relaxed"
          role={submitError ? undefined : "status"}
        >
          {submitting
            ? "Votre prestation est en cours d'évaluation. Cela peut prendre une minute ; ne fermez pas cet onglet."
            : submitError
              ? submitError.retryable
                ? "Votre prestation attend d'être envoyée."
                : "Votre prestation a bien été enregistrée, mais elle n'a pas pu être corrigée."
              : // Not idle: the recordings are being compressed before they are
                // sent, which takes a few seconds for a full sitting.
                "Préparation de votre enregistrement…"}
        </p>
      </div>

      {droppedPhases.length > 0 && (
        <Notice tone="warning" title="Un enregistrement n'a pas pu être envoyé">
          {droppedPhases.length === 2
            ? "Vos deux prises de parole étaient trop volumineuses pour être envoyées."
            : `Votre ${PHASE_LABEL_FR[droppedPhases[0]]} était trop volumineux pour être envoyé.`}{" "}
          Cette partie sera corrigée à partir de sa transcription seule, sans
          écoute de votre prononciation, et comptera comme une durée de zéro
          seconde dans la pénalité de durée.
        </Notice>
      )}

      {submitError && (
        <Notice
          tone="danger"
          title={
            submitError.retryable
              ? "L'envoi a échoué"
              : "Cette épreuve ne peut pas être corrigée"
          }
          action={
            <div className="flex flex-wrap gap-2">
              {/* The retry is offered only when it could work. A button under a
                  413 or a 422 would send the same bytes to the same refusal, and
                  the candidate would sit through it twice. */}
              {submitError.retryable && (
                <button type="button" onClick={onRetry} className={dangerButton}>
                  Réessayer l&apos;envoi
                </button>
              )}
              <button type="button" onClick={onLeave} className={secondaryButton}>
                {submitError.retryable
                  ? "Abandonner et revenir au tableau de bord"
                  : "Revenir au tableau de bord"}
              </button>
            </div>
          }
        >
          {submitError.message}
        </Notice>
      )}
    </main>
  );
}

function Briefing({
  topic,
  onStart,
  canEncode,
  checking,
}: {
  topic: OralTopic;
  onStart: () => void;
  /** Null while the browser is still being asked, and if it never answered. */
  canEncode: boolean | null;
  /** Whether that question is still open. See `ExamClient`. */
  checking: boolean;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-2">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          Avant de commencer
        </p>
        <h1 className="font-serif text-2xl leading-tight font-semibold text-balance">
          {topic.title}
        </h1>
      </div>

      <ol className="border-border divide-border divide-y rounded-lg border">
        {[
          ["1", "30 minutes de préparation", "Vous pouvez prendre des notes."],
          [
            "2",
            "Monologue suivi de 5 à 7 minutes",
            "L'examinateur écoute sans vous interrompre.",
          ],
          [
            "3",
            "Débat d'environ 13 minutes",
            "L'examinateur conteste votre position ; défendez-la.",
          ],
          [
            "4",
            "Évaluation sur 25 points",
            "Cinq critères, selon la grille officielle de la production orale.",
          ],
        ].map(([step, title, detail]) => (
          <li key={step} className="flex gap-3 px-4 py-3">
            <span className="bg-primary-subtle text-primary tabular flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
              {step}
            </span>
            <div>
              <p className="text-sm font-semibold">{title}</p>
              <p className="text-muted-foreground text-sm leading-relaxed">{detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <Notice tone="info" title="Microphone et enregistrement">
        Le microphone vous sera demandé au début du monologue, pas maintenant. Rien
        n&apos;est enregistré avant que vous ne l&apos;autorisiez : un témoin
        &laquo;&nbsp;Enregistrement&nbsp;&raquo; reste visible en haut de
        l&apos;écran pendant toute l&apos;épreuve. Vos deux prises de parole sont
        enregistrées séparément, puis envoyées pour la correction une fois
        l&apos;épreuve terminée. Utilisez un casque : sans lui, l&apos;examinateur
        s&apos;entend lui-même et la transcription en souffre.
      </Notice>

      {canEncode === false && (
        // Said here, and only here: after the épreuve the candidate can do
        // nothing about it, and the results page will only be able to report
        // that the correction was made without the audio.
        <Notice tone="danger" title="Votre navigateur ne peut pas envoyer l'enregistrement">
          Il ne sait pas compresser l&apos;audio. Votre prestation sera corrigée à
          partir de la transcription seule, sans écoute de votre prononciation, et
          la pénalité de durée s&apos;appliquera comme si aucun enregistrement
          n&apos;existait. Passez plutôt l&apos;épreuve sur une version récente de
          Chrome, Edge, Safari ou Firefox.
        </Notice>
      )}

      {/* Held shut until the browser has answered, so the warning above cannot
          be outrun by a candidate clicking straight through. */}
      <button
        type="button"
        onClick={onStart}
        disabled={checking}
        className={`${primaryButton} self-start px-5 py-2.5`}
      >
        {checking ? "Vérification de votre navigateur…" : "Commencer la préparation"}
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
      <SubjectDocument topic={topic} />

      <section className="border-border bg-card flex flex-col rounded-lg border p-5">
        <h2 className="text-sm font-semibold">
          <label htmlFor="notes">Vos notes</label>
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Elles resteront visibles pendant votre monologue.
        </p>
        <textarea
          id="notes"
          value={notes}
          onChange={(event) => onNotes(event.target.value)}
          placeholder="Introduction, thèse, arguments, exemples, conclusion…"
          className="border-border mt-3 min-h-64 flex-1 resize-none rounded-md border bg-transparent p-3 text-sm leading-relaxed outline-none"
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
      <section className="border-border bg-card flex flex-col rounded-lg border">
        {/* Who has the floor. A live region because it changes while the
            candidate is listening rather than looking, and the whole task
            depends on knowing whether it is their turn. */}
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center gap-2 rounded-t-lg border-b px-5 py-3 ${
            examinerSpeaking
              ? "border-border bg-primary-subtle text-primary"
              : "border-border bg-success-subtle text-success"
          }`}
        >
          <span className="text-sm" aria-hidden>
            {examinerSpeaking ? "🗣" : "🎙"}
          </span>
          <h2 className="text-sm font-semibold">
            {examinerSpeaking
              ? "L'examinateur parle, écoutez."
              : phase === "monologue"
                ? "Vous avez la parole. L'examinateur ne vous interrompra pas."
                : "À vous de répondre."}
          </h2>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm leading-relaxed">
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
                className={`text-[0.6875rem] font-semibold tracking-[0.16em] uppercase ${
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

      <section className="border-border bg-card rounded-lg border p-5">
        <h2 className="text-sm font-semibold">Vos notes</h2>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed whitespace-pre-wrap">
          {notes.trim() || "Aucune note prise pendant la préparation."}
        </p>
      </section>
    </div>
  );
}
