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
  /** The sitting. Reaches the token route, which refuses to mint for a sitting
   *  the caller does not own — so it stops here rather than in the controller,
   *  which has no business knowing about row ids. */
  examId: string;
  topic: OralTopic;
  onFinished: (payload: ExamFinishedPayload) => void;
}) {
  const { examId, topic, onFinished } = options;

  const controller = useMemo(
    () =>
      new ExamController({
        topic,
        createSession: (phase, sessionTopic, callbacks, initialHistory) =>
          new ExamLiveSession({ examId, phase, topic: sessionTopic, callbacks, initialHistory }),
        createRecorder: (callbacks) => new MicRecorder(callbacks),
        createPlayer: (callbacks) => new ExaminerAudioPlayer(callbacks),
        onFinished,
      }),
    [examId, topic, onFinished],
  );

  /**
   * Release the microphone and the socket when the candidate leaves.
   *
   * Unmount alone is not enough, and the gap is not theoretical: closing the
   * tab, navigating away, or backgrounding on iOS unmounts nothing. React runs
   * no cleanup, so the recording indicator stays lit and the AudioContext stays
   * open until the browser gets round to reaping the page.
   *
   * `pagehide` rather than `beforeunload` because it is the one that fires on
   * mobile Safari, and it fires for bfcache too. A page frozen into the bfcache
   * comes back with its devices released and its listeners gone rather than
   * live — which is the right way round: an épreuve does not resume from a back
   * button, and a suspended tab holding the microphone is worse than one that
   * has to be restarted.
   *
   * When the microphone is already open — the case that matters, because that
   * is when a device is actually held — `destroy()` reaches
   * `stream.getTracks().forEach(stop)` before its first await, so the release
   * happens inside this event's own call stack rather than on a tick the
   * browser owes an unloading page nothing. It is not an unconditional
   * guarantee: if capture is still waiting on the permission prompt, `stop()`
   * awaits that first. Nothing is held yet in that case, and the controller's
   * own teardown flag stops the device being adopted if it does arrive.
   */
  useEffect(() => {
    const release = () => controller.destroy();
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      controller.destroy();
    };
  }, [controller]);

  const state: ExamState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return { state, controller };
}
