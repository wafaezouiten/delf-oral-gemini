"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Notice } from "@/app/_components/notice";
import { dangerButton } from "@/app/_components/button-styles";
import { ExitDialog } from "@/app/_components/po/exit-dialog";
import { useExamController } from "@/lib/live/use-exam-controller";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import { isOpusEncodingSupported } from "@/lib/audio/opus-encoder";
import { selectDeliverable } from "@/lib/exams/uploaded-recording";
import { requestAbandon } from "@/lib/exams/abandon";
import { describeFinishFailure, type FinishFailure } from "@/lib/ui/finish-failure";
import type { OralTopic } from "@/lib/delf/topics";
import { AnnouncementCard } from "./_components/announcement-card";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import { DevTranscriptionPanel } from "./_components/dev-transcription-panel";
import { BriefingScreen } from "./_components/briefing-screen";
import { PreparationScreen } from "./_components/preparation-screen";
import { PassationScreen } from "./_components/passation-screen";
import { FinishedScreen } from "./_components/finished-screen";

/**
 * The simulateur: one screen per phase, and a phase switch.
 *
 * PORT NOTE: this is the reference's `simulateur-client.tsx` — an orchestrator
 * that holds the notes, the exit dialog and the finished payload, decides which
 * of four screens is on, and owns no layout at all. Every branch below returns a
 * whole screen rather than composing one out of conditionals, which is the
 * property that made the reference's four screens possible to reason about
 * separately.
 *
 * What is NOT the reference's is everything about the épreuve itself: the phases,
 * the clocks, the socket, the microphone and the upload all belong to
 * `ExamController` exactly as before. This file was reshaped, not rewritten —
 * the finish handler below is unchanged from the screen this replaces, down to
 * the comments, because none of what it says stopped being true when the layout
 * changed.
 */

/**
 * How long the briefing waits for the browser to say whether it can encode.
 *
 * `AudioEncoder.isConfigSupported` answers in milliseconds; this is only here so
 * that one that never answers costs the candidate three seconds rather than the
 * épreuve.
 */
const BROWSER_CHECK_TIMEOUT_MS = 3_000;

export function ExamClient({ examId, topic }: { examId: string; topic: OralTopic }) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  /**
   * Whether the débat prints its exchange (#48). Open by default.
   *
   * Here rather than in `PassationScreen` for the same reason `notesOpen` is:
   * that screen owns no state, which is what lets it stay a layout. It also has
   * to survive the phase change — a candidate who hid the feed and then saw it
   * come back because the screen re-rendered would have to hide it twice.
   */
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [abandonFailed, setAbandonFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FinishFailure | null>(null);
  const submittedRef = useRef(false);

  /**
   * The phases whose recording could not be attached to the finish request.
   *
   * Rendered rather than only logged, which is the whole point: a candidate
   * should be able to go from start to correction without reading a console, and
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
   * payload is the only thing that was missing, and without it the retry had no
   * way to be offered. The audio lives in this tab and nowhere else, so this ref
   * is the last copy of the épreuve; it is not cleared on success only because
   * the screen navigates away.
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
        // Undefined on any sitting that was actually spoken, and ignored by the
        // route in a production build (#36).
        devSeconds: payload.devSeconds,
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
   * before it could render, and the briefing does not come back.
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

  const leave = () => router.push("/app");

  /**
   * End the current phase.
   *
   * The refusal is no longer here. A monologue with no speech on it is held
   * open by the controller — on this button *and* on its own time-up — because
   * the second of those is a path the screen cannot see. Leaving the rule in
   * one place is what keeps the two from disagreeing; this just calls it, and
   * reads `state.monologueHeld` to know what to draw.
   */
  const advance = () => void controller.advanceEarly();

  /**
   * Abandon: mark the sitting, confirm it was marked, then leave.
   *
   * The exit dialog promises the candidate this épreuve will count as a zero, so
   * the promise has to be kept before the navigation — not handed to a server
   * that would otherwise only ever see a sitting go quiet, which is
   * indistinguishable from a flat battery.
   *
   * This is **awaited**, and the first version's refusal to await it is what
   * made #38: it fired the request and called `router.push` in the same tick, on
   * the reasoning that the page was being torn down. `router.push` is a soft
   * navigation — React stays mounted, nothing unloads — so there was nothing to
   * outrun, and the dashboard could render from a history the write had not
   * reached yet. `requestAbandon` bounds the wait so awaiting cannot strand a
   * candidate who has already decided to leave.
   *
   * `router.refresh()` after the push for the other half of the same symptom:
   * `/app` is `force-dynamic`, but a soft navigation can still be served from
   * the client Router Cache, and the whole point of this call is that the page
   * they land on has changed.
   */
  const abandon = async () => {
    if (abandoning) return;
    setAbandoning(true);
    setAbandonFailed(false);

    const outcome = await requestAbandon(examId);
    if (!outcome.recorded) {
      // Told, not swallowed. The candidate was promised a zero; if the product
      // could not record one, saying nothing would be the second broken promise
      // of the same click. They keep both ways forward — retry, or go anyway.
      console.warn("[abandon] the walk-out was not recorded on the server", outcome);
      setAbandoning(false);
      setAbandonFailed(true);
      return;
    }

    leave();
    router.refresh();
  };

  /**
   * Every failure the épreuve can produce, in the order a candidate cares about
   * it: the connection that has stopped coming back, then the microphone. Both
   * are messages first and a control second — a red button on its own is not an
   * explanation.
   *
   * Shared by the préparation and passation screens rather than written into
   * each, because a failure is not less true for having happened during the
   * quiet phase: the microphone can be refused while the browser is asked for
   * it, which happens on the boundary between the two.
   */
  const notices = (
    <>
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
          Les tentatives automatiques de reconnexion n&apos;ont pas abouti. Le
          temps de cette partie continue de s&apos;écouler et ce qui a déjà été
          dit est conservé. Vérifiez votre connexion internet, puis reprenez.
        </Notice>
      )}

      {state.micError && (
        <Notice tone="warning" title="Microphone">
          {state.micError}
        </Notice>
      )}
    </>
  );

  const hasNotices = state.status === "error" || Boolean(state.micError);

  /**
   * The examiner's spoken consigne, on both screens it can appear on (#37).
   *
   * One element handed to whichever screen is up, rather than each screen building
   * its own: the card has to survive the préparation → monologue boundary looking
   * like the same card, and the four controller calls behind it should not be
   * written down twice.
   */
  /**
   * The phase is open but has not begun: the consigne is playing, or is held
   * waiting for a click the browser's autoplay policy made necessary (#37).
   *
   * Derived here rather than added to `ExamState`, because it is exactly the two
   * flags below in the two phases this branch renders — and the screens it feeds
   * need it to keep from printing "you are being recorded and your time has
   * started" over a phase where neither is true yet.
   */
  const awaitingConsigne = state.announcementPlaying || state.announcementBlocked;

  const announcement = (
    <AnnouncementCard
      announcement={state.announcement}
      playing={state.announcementPlaying}
      blocked={state.announcementBlocked}
      muted={state.announcementsMuted}
      onPlay={() => controller.playAnnouncement()}
      onSkip={() => controller.skipAnnouncement()}
      onMute={() => controller.muteAnnouncements()}
    />
  );

  // ------------------------------------------------------------------ screens

  if (!state.started) {
    return (
      <BriefingScreen
        topic={topic}
        canEncode={canEncode}
        checking={checkingBrowser}
        onStart={() => controller.start()}
        onSkip={() => {
          // The reference's "Passer et aller directement à l'épreuve", against a
          // controller that has no such jump: preparation must be entered before
          // it can be left early. Two calls rather than a new controller path,
          // because the second one is the same button the préparation rail
          // offers and shares its microphone prompt.
          controller.start();
          void controller.advanceEarly();
        }}
        onBack={leave}
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
        onLeave={leave}
        announcement={announcement}
      />
    );
  }

  const exitDialog = (
    <ExitDialog
      open={showExitDialog}
      pending={abandoning}
      failed={abandonFailed}
      onCancel={() => {
        setShowExitDialog(false);
        setAbandonFailed(false);
      }}
      onConfirm={() => void abandon()}
      onLeaveAnyway={leave}
    />
  );

  if (state.phase === "preparation") {
    return (
      <>
        <PreparationScreen
          topic={topic}
          notes={notes}
          onNotes={setNotes}
          remaining={state.remaining}
          onStartExam={() => void controller.advanceEarly()}
          onExit={() => setShowExitDialog(true)}
          notices={hasNotices ? notices : undefined}
          announcement={announcement}
        />
        {exitDialog}
      </>
    );
  }

  return (
    <>
      <PassationScreen
        phase={state.phase}
        topic={topic}
        elapsed={state.elapsed}
        remaining={state.remaining}
        recording={state.recording}
        connected={state.connection === "connected"}
        connecting={state.connection === "connecting"}
        canAdvance={state.canAdvance}
        awaitingStart={state.awaitingStart}
        onStart={() => controller.startSpeaking()}
        notes={notes}
        notesOpen={notesOpen}
        onToggleNotes={() => setNotesOpen((open) => !open)}
        transcript={state.transcript}
        transcriptOpen={transcriptOpen}
        onToggleTranscript={() => setTranscriptOpen((open) => !open)}
        onAdvance={advance}
        onExit={() => setShowExitDialog(true)}
        emptyTranscript={state.monologueHeld}
        onRetryTranscription={() => controller.restartMonologue()}
        notices={hasNotices ? notices : undefined}
        announcement={announcement}
        awaitingConsigne={awaitingConsigne}
        devPanel={
          DEV_TOOLS_ENABLED ? (
            <div className="space-y-2">
              {/* The exposé and nowhere else. The débat is spoken, and the
                  controller hands the microphone back when the monologue ends
                  so it can be. */}
              {state.phase === "monologue" && (
                <DevTranscriptionPanel
                  subject={topic.title}
                  active={state.devTextMode}
                  onActiveChange={(on) => controller.setDevTextMode(on)}
                  // The two states in which the button cannot do what it says,
                  // handed over so the panel can say which one it is in rather
                  // than looking like it did nothing (#53).
                  awaitingConsigne={awaitingConsigne}
                  closing={state.closing}
                  // « Envoyer l'exposé » ends the monologue: the text is not a
                  // fragment of it, it is the whole thing — and it starts the
                  // part first if « Enregistrer » has not been pressed, which is
                  // the flow this panel exists for. It answers whether the
                  // exposé counted; the panel keeps the text when it did not.
                  onSubmit={(text, seconds) => controller.submitTypedExpose(text, seconds)}
                />
              )}
              {/* Drives the path a real GoAway takes, so the 13-minute
                  resumption behaviour can be exercised in seconds instead of
                  waiting for the connection limit. Stands down once the real
                  recovery control is on screen in the notice above — two
                  buttons doing the same thing side by side is how a developer
                  ends up testing the wrong one. */}
              {state.status !== "error" && (
                <button
                  type="button"
                  onClick={() => void controller.forceReconnect()}
                  className="border-border text-muted-foreground rounded-md border px-3 py-1.5 text-xs font-semibold"
                >
                  Forcer une reconnexion ({state.reconnectCount})
                </button>
              )}
            </div>
          ) : undefined
        }
      />
      {exitDialog}
    </>
  );
}
