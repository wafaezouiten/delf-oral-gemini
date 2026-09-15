/**
 * The recording player's decisions (#98, #234): what to ask the browser, what
 * the clock and the bar show, and the two-step deletion.
 */

/**
 * The type `canPlayType` is asked about. The Ogg case is asked with its codec:
 * bare `audio/ogg` gets "maybe" from browsers that would then fail on the Opus
 * inside. The stored types are exactly the two `measureUploadedRecording` can
 * admit.
 */
export function playableCandidate(mimeType: string): string {
  return mimeType === "audio/ogg" ? 'audio/ogg; codecs="opus"' : mimeType;
}

/** The format's name in the sentence a refusing browser is shown. */
export function formatName(mimeType: string): string {
  return mimeType === "audio/ogg" ? "Ogg Opus" : mimeType;
}

/** A seek held inside the recording; a duration of 0 pins it to the start. */
export function clampSeek(seconds: number, duration: number): number {
  return Math.min(Math.max(seconds, 0), duration || 0);
}

/** The bar's fill, 0–1. */
export function playbackProgress(time: number, duration: number): number {
  return duration > 0 ? Math.min(time / duration, 1) : 0;
}

/** How far an arrow key on the track moves the head, or null for any other key. */
export function seekKeyOffset(key: string): number | null {
  if (key === "ArrowLeft") return -5;
  if (key === "ArrowRight") return 5;
  return null;
}

/**
 * « Supprimer », in two presses. One arms it, a second confirms; a failure
 * disarms and says so, and the sentence stays until the next attempt.
 */
export interface DeletionState {
  stage: "idle" | "confirming" | "deleting" | "deleted";
  failed: boolean;
}

export type DeletionEvent = "arm" | "cancel" | "start" | "ok" | "fail";

export const DELETION_IDLE: DeletionState = { stage: "idle", failed: false };

export function deletionReducer(state: DeletionState, event: DeletionEvent): DeletionState {
  switch (event) {
    case "arm":
      return { ...state, stage: "confirming" };
    case "cancel":
      return { ...state, stage: "idle" };
    case "start":
      return { stage: "deleting", failed: false };
    case "ok":
      return { stage: "deleted", failed: false };
    case "fail":
      // The row still has its bytes; the honest state is the card, with a
      // sentence, not a card that pretends the voice is gone.
      return { stage: "idle", failed: true };
  }
}
