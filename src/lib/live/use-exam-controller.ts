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

  /**
   * Ask before a reload throws the recording away.
   *
   * The candidate's audio lives in this tab's memory and nowhere else until the
   * épreuve ends and it is uploaded — deliberately, since streaming it somewhere
   * as it is captured would mean retaining audio for a sitting that may be
   * abandoned. The cost is that F5 during a débat destroys eighteen minutes of
   * recording AND restarts the épreuve from preparation, silently, on a
   * keystroke people press by reflex when a page looks stuck.
   *
   * `beforeunload` is the only hook the browser offers for saying so, and all it
   * buys is the generic "leave site?" dialog — which is enough to turn an
   * accident into a decision. It does NOT replace the `pagehide` teardown above:
   * a candidate who confirms still leaves, and must still leave with the
   * microphone released.
   *
   * Registered only while something is actually being recorded. An unconditional
   * handler blocks the bfcache for the whole sitting and nags on the way out of
   * a finished exam, which is the fastest way to teach someone to click through
   * the dialog without reading it.
   */
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!controller.getSnapshot().recording) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [controller]);

  const state: ExamState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return { state, controller };
}
