/**
 * What the controller needs from a Gemini session, as an interface the
 * session `implements`: a forgotten method is a compile error rather than a
 * directive that never sends. A leaf, so `session-manager.ts` can say so
 * without importing the controller that drives it. The audio devices' ports
 * are `audio/ports.ts`, for the same reason on their side.
 */

/** What the controller needs from a Gemini session. */
export interface LiveSessionLike {
  connect(): Promise<void>;
  close(): void;
  reconnect(): Promise<void>;
  sendAudio(base64: string): void;
  sendDirective(text: string): void;
  beginCandidateActivity(): void;
  endCandidateActivity(): void;
}
