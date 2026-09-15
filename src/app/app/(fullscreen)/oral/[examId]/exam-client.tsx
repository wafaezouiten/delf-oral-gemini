"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { OralTopic } from "@/lib/delf/topics";
import { DEV_TOOLS_ENABLED } from "@/lib/dev-tools";
import {
  buildFinishForm,
  submitFinish,
  type FinishOutcome,
  type SpeakingPhase,
} from "@/lib/exams/finish-submission";
import type { ExamFinishedPayload } from "@/lib/live/exam-controller";
import { useExamController } from "@/lib/live/use-exam-controller";
import {
  savedPromptServerSnapshot,
  savedPromptSnapshot,
  subscribeSavedPrompt,
} from "@/lib/ui/dev-examiner-prompt-storage";
import type { FinishFailure } from "@/lib/ui/finish-failure";
import { finishStage } from "@/lib/ui/finish-progress";

import { AnnouncementControl } from "./_components/announcement-control";
import { ExamExitDialogs, useExamExit } from "./_components/exam-exit";
import { ExamNotices, hasExamNotices } from "./_components/exam-notices";
import { FinishedScreen } from "./_components/finished-screen";
import { OralDevPanel } from "./_components/oral-dev-panel";
import { PassationScreen } from "./_components/passation-screen";
import { PreparationScreen } from "./_components/preparation-screen";
import { useBrowserCheck } from "./_components/use-browser-check";
import { useExaminerChoice } from "./_components/use-examiner-choice";

/**
 * The simulateur: one screen per phase, and a phase switch.
 *
 * PORT NOTE: this is the reference's `simulateur-client.tsx` — an orchestrator
 * that holds the notes, the exit dialog and the finished payload, decides which
 * screen is on, and owns no layout at all. Every branch below returns a whole
 * screen rather than composing one out of conditionals, which is the property
 * that made the reference's screens possible to reason about separately.
 *
 * There were four; there are three (#55). The briefing that opened the sequence
 * is gone, and with it the second « Commencer » a candidate had to press to
 * reach the préparation they had already asked for. The épreuve now starts when
 * this page does.
 *
 * What is NOT the reference's is everything about the épreuve itself: the phases,
 * the clocks, the socket, the microphone and the upload all belong to
 * `ExamController` exactly as before.
 *
 * What this file holds is the state each screen draws and the one switch.
 * Everything it used to decide is elsewhere and tested (#234): handing the
 * sitting in is `lib/exams/finish-submission.ts`, which way out « Quitter »
 * opens is `lib/ui/exam-exit.ts`, when the dev time-skip may show is
 * `lib/ui/dev-time-skip.ts`; the three ways out and their dialogs are
 * `_components/exam-exit.tsx`, the notices `_components/exam-notices.tsx`, the
 * development cluster `_components/oral-dev-panel.tsx`.
 */

export function ExamClient({
  examId,
  topic,
  storedExaminerModel,
}: {
  examId: string;
  topic: OralTopic;
  storedExaminerModel: string | null;
}) {
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [promptPanelOpen, setPromptPanelOpen] = useState(false);

  const examiner = useExaminerChoice(examId, storedExaminerModel);
  const finish = useFinish(examId, topic, examiner.ref);

  const { state, controller } = useExamController({
    examId,
    topic,
    examinerModel: examiner.model,
    onFinished: finish.submit,
  });

  const exit = useExamExit(examId, controller);
  const { canEncode, checking } = useBrowserCheck();

  // The prompt saved for this sujet (#166), applied to the controller before
  // the débat's socket opens, and handed to the editor as its starting text.
  const savedPrompt = useSyncExternalStore(
    subscribeSavedPrompt,
    () => (DEV_TOOLS_ENABLED ? savedPromptSnapshot(topic.slug) : null),
    savedPromptServerSnapshot,
  );
  useEffect(() => {
    if (savedPrompt) controller.setExaminerPrompt(savedPrompt.prompt);
  }, [controller, savedPrompt]);

  // The épreuve starts when this page does (#55).
  useEffect(() => {
    controller.start();
  }, [controller]);

  const awaitingConsigne = state.announcementPlaying;
  const announcement = (
    <AnnouncementControl
      playing={state.announcementPlaying}
      onSkip={() => controller.skipAnnouncement()}
    />
  );

  if (state.phase === "finished") {
    return (
      <FinishedScreen
        stage={finishStage(finish.submitting, finish.uploadFraction, finish.awaitingCorrection)}
        submitError={finish.error}
        droppedPhases={finish.droppedPhases}
        onRetry={finish.retry}
        onLeave={exit.leave}
        announcement={announcement}
      />
    );
  }

  // The notices are shared by the two screens rather than written into each:
  // a failure is not less true for having happened during the quiet phase, and
  // the microphone can be refused on the boundary between the two. The
  // encoding notice is the préparation's alone — after it the candidate can do
  // nothing about it (#24), and the results page reports the consequence.
  const notices = (screen: "preparation" | "passation") => {
    const encode = screen === "preparation" ? canEncode : null;
    return hasExamNotices(state, encode) ? (
      <ExamNotices
        state={state}
        canEncode={encode}
        onReconnect={() => void controller.forceReconnect()}
      />
    ) : undefined;
  };

  if (state.phase === "preparation") {
    return (
      <>
        <PreparationScreen
          topic={topic}
          notes={notes}
          onNotes={setNotes}
          remaining={state.remaining}
          onStartExam={() => void controller.advanceEarly()}
          onExit={() => exit.open(state)}
          checking={checking}
          examinerModel={examiner.model}
          examinerSaving={examiner.saving}
          examinerError={examiner.failed}
          onChooseExaminer={(model) => void examiner.choose(model)}
          notices={notices("preparation")}
          announcement={announcement}
        />
        <ExamExitDialogs phase={state.phase} dialogs={exit.dialogs} onLeave={exit.leave} />
      </>
    );
  }

  return (
    <>
      <PassationScreen
        phase={state.phase}
        topic={topic}
        elapsed={state.elapsed}
        phaseStartedAt={state.phaseStartedAt}
        remaining={state.remaining}
        recording={state.recording}
        examinerSpeaking={state.examinerSpeaking}
        openingQuestionPending={state.openingQuestionPending}
        connected={state.connection === "connected"}
        connecting={state.connection === "connecting"}
        canAdvance={state.canAdvance}
        awaitingStart={state.awaitingStart}
        closing={state.closing}
        onStart={() => controller.startSpeaking()}
        notes={notes}
        notesOpen={notesOpen}
        onToggleNotes={() => setNotesOpen((open) => !open)}
        transcript={state.transcript}
        onAdvance={() => void controller.advanceEarly()}
        onExit={() => exit.open(state)}
        emptyTranscript={state.monologueHeld}
        onRetryTranscription={() => controller.restartMonologue()}
        notices={notices("passation")}
        announcement={announcement}
        awaitingConsigne={awaitingConsigne}
        devPanel={
          DEV_TOOLS_ENABLED ? (
            <OralDevPanel
              state={state}
              controller={controller}
              topic={topic}
              examinerModel={examiner.model}
              savedPrompt={savedPrompt}
              promptPanelOpen={promptPanelOpen}
              onPromptPanelOpen={setPromptPanelOpen}
              awaitingConsigne={awaitingConsigne}
            />
          ) : undefined
        }
      />
      <ExamExitDialogs phase={state.phase} dialogs={exit.dialogs} onLeave={exit.leave} />
    </>
  );
}

/**
 * Handing the sitting in, and the state the finished screen draws while it
 * happens.
 *
 * The exchange itself — the form, the answer, the wait for a correction
 * computed behind a 202 — is `lib/exams/finish-submission.ts`; what stays
 * here is what the screen shows (uploading, waiting, failed, and which phases
 * went up without their audio) and where it goes afterwards.
 *
 * `submittedRef` refuses a second submission while one is in flight and is
 * reset on failure, so the retry is offered; `payloadRef` is the finished
 * sitting kept for that retry — the audio lives in this tab and nowhere
 * else, so it is the last copy of the épreuve, not cleared on success only
 * because the screen navigates away. `liveRef` is the same guard
 * `isOpusEncodingSupported` has, held in a ref because the wait starts from a
 * callback rather than an effect.
 *
 * The evaluation is stashed in sessionStorage as well as persisted, so the
 * results page renders even with no database configured. The recordings go
 * up as one file per phase: the duration floors are per task, and two
 * artefacts are what lets a candidate re-listen to the half that went wrong.
 * Multipart, because a 13-minute recording has no business being base64'd
 * into a JSON body.
 */
function useFinish(examId: string, topic: OralTopic, examinerModelRef: React.RefObject<string>) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FinishFailure | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [awaitingCorrection, setAwaitingCorrection] = useState(false);
  // Rendered rather than only logged: a candidate should be able to go from
  // start to correction without reading a console, and "your débat was graded
  // from the transcript and measured zero seconds" used to live in a
  // `console.warn` nobody opens. Said here, at the moment it happens, because
  // the results page is read back from the database and this is not a fact
  // the database holds.
  const [droppedPhases, setDroppedPhases] = useState<SpeakingPhase[]>([]);
  const liveRef = useRef(true);
  const submittedRef = useRef(false);
  const payloadRef = useRef<ExamFinishedPayload | null>(null);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const settle = useCallback(
    (outcome: FinishOutcome) => {
      if (outcome.kind === "corrected") {
        router.replace(`/app/results/${examId}`);
      } else if (outcome.kind === "stashed") {
        sessionStorage.setItem(`delf-eval-${examId}`, JSON.stringify(outcome.stash));
        router.replace(`/app/results/${examId}`);
      } else if (outcome.kind === "failed") {
        setAwaitingCorrection(false);
        setError(outcome.failure);
        setSubmitting(false);
        submittedRef.current = false;
      }
      // `cancelled`: the screen is gone; nothing to draw.
    },
    [examId, router],
  );

  const submit = useCallback(
    async (payload: ExamFinishedPayload) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      payloadRef.current = payload;
      setSubmitting(true);
      setError(null);
      setUploadFraction(null);
      setAwaitingCorrection(false);

      const { form, dropped } = buildFinishForm(payload, topic.slug);
      setDroppedPhases(dropped);

      settle(
        await submitFinish({
          examId,
          topic,
          payload,
          form,
          examinerModel: examinerModelRef.current,
          onUploadProgress: setUploadFraction,
          onAwaitingCorrection: () => setAwaitingCorrection(true),
          cancelled: () => !liveRef.current,
        }),
      );
    },
    [examId, topic, examinerModelRef, settle],
  );

  const retry = useCallback(() => {
    const payload = payloadRef.current;
    if (payload) void submit(payload);
  }, [submit]);

  return { submit, retry, submitting, error, uploadFraction, awaitingCorrection, droppedPhases };
}
