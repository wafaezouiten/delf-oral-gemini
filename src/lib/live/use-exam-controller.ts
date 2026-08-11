"use client";

/**
 * React binding for `ExamController`.
 *
 * Everything interesting lives in the controller; this is a
 * `useSyncExternalStore` subscription and the browser wiring (a real Gemini
 * session, a real microphone, a real speaker). Keeping the binding this thin is
 * the point — the exam logic is testable without React, and React never owns
 * mutable exam state.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { MicRecorder } from "@/lib/audio/recorder";
import { ExaminerAudioPlayer } from "@/lib/audio/player";
import type { OralTopic } from "@/lib/delf/topics";
import { ExamController, type ExamFinishedPayload, type ExamState } from "./exam-controller";
import { ExamLiveSession } from "./session-manager";

export type { ExamEvent, ExamState } from "./exam-controller";

export function useExamController(options: {
  topic: OralTopic;
  onFinished: (payload: ExamFinishedPayload) => void;
}) {
  const { topic, onFinished } = options;

  const controller = useMemo(
    () =>
      new ExamController({
        topic,
        createSession: (phase, sessionTopic, callbacks, history) =>
          new ExamLiveSession(phase, sessionTopic, callbacks, history),
        createRecorder: (onChunk) => new MicRecorder({ onChunk }),
        createPlayer: (onSpeakingChange) => new ExaminerAudioPlayer(onSpeakingChange),
        onFinished,
      }),
    [topic, onFinished],
  );

  // Release the microphone and the socket when the candidate leaves the page.
  useEffect(() => () => controller.destroy(), [controller]);

  const state: ExamState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return { state, controller };
}
