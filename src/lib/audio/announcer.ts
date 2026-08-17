/**
 * Playback for the examiner's spoken consignes (#37).
 *
 * A deliberately separate path from `player.ts`, and the split is not
 * duplication. That one schedules an unbounded stream of base64 PCM chunks
 * arriving faster than real time from a Live socket, and its whole substance is
 * the scheduling cursor that stops them overlapping. This one plays one finished
 * file from `public/` and reports how it ended. Feeding a static clip through the
 * streaming player would mean decoding a WAV by hand to hand it back its own
 * samples, for no benefit.
 *
 * What the caller actually needs from this is the **outcome**, which is why
 * `play()` resolves rather than returning void:
 *
 *  - `played` — the candidate heard it, and the phase may now start.
 *  - `skipped` — they silenced it. Same thing as far as the exam is concerned.
 *  - `blocked` — the browser refused to autoplay. NOT the same thing: nothing was
 *    heard and a gesture would fix it, so the controller holds the phase and puts
 *    a button on screen rather than starting a recording the consigne would then
 *    be played into. See `ExamController.announce`.
 *  - `failed` — the file is missing or undecodable. Nothing to be done, and the
 *    épreuve is still worth sitting: the text is on screen either way.
 *
 * The clip arrives through {@link ClipPlayer} rather than `new Audio()` being
 * called here, for the same reason the AudioContext does in `player.ts`: the
 * interesting behaviour is the lifetime bookkeeping, and none of it was reachable
 * by a test while it sat behind a global only a browser provides.
 */

/** How one attempt to play a clip ended. See the header for what each obliges. */
export type AnnouncementOutcome = "played" | "skipped" | "blocked" | "failed";

/** One clip, playing. */
export interface ClipPlayback {
  /** Resolves when the clip reaches its end; rejects if it could not be played
   *  at all. A `stop()`ped clip settles neither — the announcer's own race is
   *  what reports that, because "we stopped it" is not something the browser has
   *  an event for. */
  finished: Promise<void>;
  /** Abandon it. Safe to call after it has already ended. */
  stop(): void;
}

export type ClipPlayer = (src: string) => ClipPlayback;

/**
 * The real one.
 *
 * `play()` is the half that can be refused: browsers reject it with a
 * `NotAllowedError` when there has been no user gesture, and that rejection is
 * the only warning there will ever be — the element does not fire an error and
 * the promise does not resolve. It is passed on so {@link classifyFailure} can
 * tell it apart from a missing file.
 */
export const browserClipPlayer: ClipPlayer = (src) => {
  const audio = new Audio(src);
  let done = false;

  const finished = new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      done = true;
      resolve();
    };
    audio.onerror = () => {
      done = true;
      reject(new Error(`the announcement ${src} could not be loaded`));
    };
    audio.play().catch((error: unknown) => {
      done = true;
      reject(error);
    });
  });

  return {
    finished,
    stop: () => {
      if (done) return;
      // Detached first, exactly as `player.ts` detaches `onended` before
      // stopping: pausing a clip must not look like a clip that finished, or a
      // skip would be reported as though the candidate had heard the whole
      // consigne.
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      // Releases the buffered download. Setting `src` empty makes some engines
      // raise `error`, which is why the handler above is detached first.
      audio.src = "";
    },
  };
};

/** A refusal to autoplay, told apart from a clip that is simply not there. */
function classifyFailure(error: unknown): AnnouncementOutcome {
  const blocked =
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError";
  return blocked ? "blocked" : "failed";
}

export interface AnnouncerCallbacks {
  /** Diagnostics for the session log, alongside the reconnects and the capture
   *  stalls — a consigne the browser refused to play is the same kind of fact. */
  onEvent?: (name: string, detail?: unknown) => void;
}

export interface AnnouncerOptions extends AnnouncerCallbacks {
  createClip?: ClipPlayer;
}

/** What `ExamController` needs from this. Kept narrow so the controller's tests
 *  can stand a fake in front of it. */
export interface AnnouncerLike {
  play(src: string): Promise<AnnouncementOutcome>;
  /** Silence whatever is playing. The pending `play()` resolves `skipped`. */
  stop(): void;
  /** Terminal. Every later `play()` resolves `skipped` without opening anything. */
  close(): void;
}

export class ExaminerAnnouncer implements AnnouncerLike {
  private playback: ClipPlayback | null = null;
  /** Resolves the in-flight `play()` when something other than the clip itself
   *  decides how it ended — a skip, a close, or a second announcement. */
  private settle: ((outcome: AnnouncementOutcome) => void) | null = null;
  /**
   * Bumped on every `play()`. A clip that has been superseded must not tidy away
   * the fields belonging to the one that replaced it — the ordering that makes
   * that reachable is a candidate pressing « Réécouter » while the consigne is
   * still playing.
   */
  private generation = 0;
  private closed = false;

  private readonly createClip: ClipPlayer;
  private readonly callbacks: AnnouncerCallbacks;

  constructor(options: AnnouncerOptions = {}) {
    this.createClip = options.createClip ?? browserClipPlayer;
    this.callbacks = options;
  }

  /** Whether a clip is audible right now. */
  get isSpeaking(): boolean {
    return this.playback !== null;
  }

  async play(src: string): Promise<AnnouncementOutcome> {
    if (this.closed) return "skipped";

    // A second consigne replaces the first rather than queueing behind it. The
    // exam only ever has one thing to say at a time, and a clip still playing at
    // a phase boundary is describing the phase that just ended.
    this.abandonCurrent();
    const generation = (this.generation += 1);

    let playback: ClipPlayback;
    try {
      playback = this.createClip(src);
    } catch (error) {
      // A constructor that throws is a broken environment, not a blocked one.
      this.callbacks.onEvent?.("announcement-failed", String(error));
      return "failed";
    }

    this.playback = playback;

    const interrupted = new Promise<AnnouncementOutcome>((resolve) => {
      this.settle = resolve;
    });
    // `.catch` is attached here rather than after the race, so a clip that fails
    // *after* being skipped cannot surface as an unhandled rejection.
    const ended = playback.finished.then(
      (): AnnouncementOutcome => "played",
      (error: unknown): AnnouncementOutcome => {
        const outcome = classifyFailure(error);
        this.callbacks.onEvent?.(`announcement-${outcome}`, String(error));
        return outcome;
      },
    );

    const outcome = await Promise.race([interrupted, ended]);

    // Only if we are still the current clip. See `generation`.
    if (generation === this.generation) {
      this.playback = null;
      this.settle = null;
    }
    return outcome;
  }

  stop(): void {
    this.abandonCurrent();
  }

  close(): void {
    this.closed = true;
    this.abandonCurrent();
  }

  /**
   * Silence the current clip and tell its awaiter it was skipped.
   *
   * The awaiter is resolved BEFORE the clip is stopped, so that a `stop()`
   * implementation which synchronously raises `error` cannot win the race and
   * report a deliberate skip as a failure.
   */
  private abandonCurrent(): void {
    const settle = this.settle;
    const playback = this.playback;
    this.settle = null;
    this.playback = null;
    settle?.("skipped");
    playback?.stop();
  }
}
