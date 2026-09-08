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

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { ExaminerAnnouncer } from "@/lib/audio/announcer";
import { MicRecorder } from "@/lib/audio/recorder";
import { ExaminerAudioPlayer } from "@/lib/audio/player";
import type { OralTopic } from "@/lib/delf/topics";
import {
  ExamController,
  type ExamFinishedPayload,
  type ExamState,
  type FinalisedPhaseReport,
} from "./exam-controller";
import { ExamLiveSession } from "./session-manager";

export type { ExamEvent, ExamState } from "./exam-controller";

/**
 * Tell the server a phase has ended, and forget about it.
 *
 * Every property of this call is chosen so that it cannot cost the candidate
 * anything:
 *
 *  - **Not awaited.** The controller fires it from inside a phase transition,
 *    and the transition must not wait on a network round trip to hand the floor
 *    to the next task.
 *  - **`keepalive`.** The most valuable moment to have sent this is the one just
 *    before the tab goes away, which is exactly when an ordinary fetch is
 *    cancelled. `keepalive` asks the browser to finish it anyway.
 *  - **Swallowed.** A failure loses the insurance and nothing else: the finish
 *    request re-sends the complete transcript regardless, so the only sitting
 *    this protects is one that never reaches finish at all.
 */
function reportPhase(examId: string, report: FinalisedPhaseReport): void {
  void fetch(`/api/exams/${examId}/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch((error: unknown) => {
    console.warn(`[progress] the ${report.phase} was not recorded on the server`, error);
  });
}

export function useExamController(options: {
  /** The sitting. Reaches the token route, which refuses to mint for a sitting
   *  the caller does not own — so it stops here rather than in the controller,
   *  which has no business knowing about row ids. */
  examId: string;
  topic: OralTopic;
  /**
   * The examiner chosen on the préparation screen (#99), or null for the
   * default. Forwarded on every token mint as the fallback the server honours
   * when no sitting can be read — the stored choice outranks it otherwise.
   */
  examinerModel: string | null;
  onFinished: (payload: ExamFinishedPayload) => void;
}) {
  const { examId, topic, examinerModel, onFinished } = options;

  const controller = useMemo(
    () =>
      new ExamController({
        topic,
        createSession: (phase, sessionTopic, callbacks, initialHistory, model, examinerPrompt) =>
          new ExamLiveSession({
            examId,
            phase,
            topic: sessionTopic,
            model,
            // DEVELOPMENT ONLY (#152) — undefined on every real sitting. It
            // rides to the token route, which drops it unless that build
            // carries the tooling.
            examinerPrompt,
            callbacks,
            initialHistory,
          }),
        createRecorder: (callbacks) => new MicRecorder(callbacks),
        createPlayer: (callbacks) => new ExaminerAudioPlayer(callbacks),
        createAnnouncer: (callbacks) => new ExaminerAnnouncer(callbacks),
        onFinished,
        onPhaseFinalised: (report) => reportPhase(examId, report),
      }),
    [examId, topic, onFinished],
  );

  /**
   * Keep the controller's idea of the examiner current (#99).
   *
   * Pushed into the controller rather than listed as a dependency of the memo
   * above, because rebuilding the controller restarts the épreuve — and the
   * choice can legitimately change during the préparation. Sessions are only
   * opened after the préparation ends, and this effect has run by then: it
   * fires on mount and on every change, before the client's own `start()`
   * effect, which is declared later in the same component.
   */
  useEffect(() => {
    controller.setExaminerModel(examinerModel);
  }, [controller, examinerModel]);

  /**
   * A teardown React has asked for but which has not run yet.
   *
   * Empty except for the window between an effect cleanup and the mount that may
   * immediately follow it — which in development is every mount. Read and written
   * only by the release effect below, where the reasoning lives.
   */
  const pendingRelease = useRef<{ controller: ExamController; cancelled: boolean } | null>(null);

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
   *
   * **The cleanup queues the release rather than performing it (#160).** React's
   * StrictMode — on by default under the App Router, and this repo does not turn
   * it off — runs every effect mount → cleanup → mount in development. The
   * controller is a `useMemo`, so the same instance lives through that cycle, and
   * `destroy()` is one-way: before this, the second mount got a controller that
   * was already dead. Nothing said so. `start()` refused, the clock never
   * started, « Commencer » did nothing, and the préparation consigne was cut off
   * mid-sentence by the teardown that had just run — a room that mounted dead on
   * `next dev` and nowhere else, because live sittings had only ever been
   * exercised on production builds, where effects are not double-invoked.
   *
   * So the cleanup hands the release to a microtask, and the next mount of the
   * *same* controller calls it off. A StrictMode cycle is one synchronous commit,
   * so that cancellation always beats the microtask; a real unmount has nobody to
   * cancel it and tears down a microtask later, which costs nothing. Identity is
   * what is compared rather than a boolean, so a cleanup caused by the controller
   * itself being rebuilt still releases the instance it was for.
   *
   * `pagehide` keeps calling `destroy()` directly. It is the path that has to
   * reach `stop()` inside its own call stack, and a page that is going away is
   * not coming back to cancel anything.
   */
  useEffect(() => {
    const queued = pendingRelease.current;
    if (queued?.controller === controller) {
      queued.cancelled = true;
      pendingRelease.current = null;
    }

    const release = () => controller.destroy();
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      const deferred = { controller, cancelled: false };
      pendingRelease.current = deferred;
      queueMicrotask(() => {
        if (deferred.cancelled) return;
        if (pendingRelease.current === deferred) pendingRelease.current = null;
        controller.destroy();
      });
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
   * The listener is added and removed as recording starts and stops, rather
   * than registered once and made a no-op from inside. That distinction is not
   * cosmetic: several engines disqualify a page from the back/forward cache for
   * *having* a `beforeunload` listener at all, whether or not it ever calls
   * `preventDefault` — so a handler installed for the whole sitting would
   * quietly cost the bfcache behaviour the `pagehide` effect above is written to
   * rely on, through thirty minutes of preparation when there is nothing to
   * protect. It also stops the dialog appearing on the way out of a finished
   * exam, which is the fastest way to teach someone to click through it without
   * reading it.
   */
  const state: ExamState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (!state.recording) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.recording]);

  return { state, controller };
}
