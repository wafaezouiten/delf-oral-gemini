/**
 * The exam's state machine, declared rather than implied.
 *
 * There are genuinely TWO machines here, at different lifetimes, and the whole
 * reason a reconnect is survivable is that they are not the same machine:
 *
 *   exam phase   preparation → monologue → debate → finished   (`lib/delf/phases`)
 *   session      idle → connecting/resuming → connected → …    (this file)
 *
 * The phase machine is DELF business logic and lives with the rest of it. The
 * session machine is transport. A session dying and being resumed moves the
 * lower machine through four states and the upper one through none — which is
 * precisely the property that makes a mid-débat reconnect invisible.
 *
 * What this file adds over the bare unions the two started as:
 *
 *  1. **A transition table.** "Which states can follow which" was previously
 *     spread across the `setState` calls in `session-manager.ts`, so the only
 *     way to know whether `failed → connected` could happen was to read every
 *     call site. Now it is one object, and the manager is checked against it.
 *  2. **`resuming` as its own state, distinct from `reconnecting`.** They are
 *     different facts and the difference is the interesting one: `reconnecting`
 *     means the socket is gone, `resuming` means we are opening a new one
 *     carrying a handle, so the examiner will still remember the exam. A
 *     reconnect with no handle would restart the exam, and that used to be
 *     indistinguishable from one that would not.
 *  3. **{@link examStatus}**, which flattens the two machines into the single
 *     seven-value status the UI and the issue both talk in, in ONE place — so
 *     "are we in an error state?" cannot be answered differently by two
 *     components.
 *
 * Kept free of React, Gemini and the network so it can be exercised directly.
 * Full prose: `docs/SESSION_STATE_MACHINE.md`.
 */

import type { OralPhase } from "@/lib/delf/phases";

/**
 * The Gemini Live connection's state.
 *
 * `connecting` and `resuming` are both "opening a socket"; they are told apart
 * by whether a resumption handle is being presented, because only one of them
 * preserves the examiner's memory of the exam so far.
 */
export type SessionState =
  /** Constructed, no socket ever opened. */
  | "idle"
  /** Opening the first socket of a phase. No handle: nothing to remember yet. */
  | "connecting"
  /** Opening a socket WITH a resumption handle. The exam continues. */
  | "resuming"
  /** Live. The only state in which audio actually reaches Gemini. */
  | "connected"
  /** The socket is gone (goAway, drop, or a forced reconnect) and we are going back. */
  | "reconnecting"
  /** Closed by us, deliberately. Terminal: the phase is over. */
  | "closed"
  /** Reconnection was exhausted. Recoverable only by an explicit forced reconnect. */
  | "failed";

export const SESSION_STATES: readonly SessionState[] = [
  "idle",
  "connecting",
  "resuming",
  "connected",
  "reconnecting",
  "closed",
  "failed",
] as const;

/**
 * Which states may legally follow which.
 *
 * Two properties are worth stating, because they are what the table is for:
 *
 *  - **`connected` is only ever reached from `connecting` or `resuming`.** No
 *    path claims the exam is live without a socket having just been opened.
 *  - **`closed` is terminal.** `close()` means the phase is over; a session that
 *    could revive from it would let a torn-down monologue start talking over the
 *    débat. A forced reconnect therefore never routes through `closed` — it goes
 *    `connected → reconnecting`, which is why `reconnect()` suppresses the close
 *    event its own teardown raises.
 */
export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  // Not `resuming`: a handle can only arrive on a message from a socket, so a
  // session that has never connected cannot have one. The table says what is
  // legal, and an edge nothing can take is noise in it — if resuming a handle
  // persisted across a page reload is ever wanted, this is the edge to add back,
  // deliberately and with a test.
  idle: ["connecting", "closed"],
  connecting: ["connected", "reconnecting", "failed", "closed"],
  resuming: ["connected", "reconnecting", "failed", "closed"],
  connected: ["reconnecting", "failed", "closed"],
  reconnecting: ["connecting", "resuming", "failed", "closed"],
  // Terminal. See above.
  closed: [],
  // Not terminal: the exam screen renders "Reprendre la connexion" whenever the
  // status is `error`, and a deliberate retry also resets the attempt budget. An
  // exam that cannot be retried is worse than one that can.
  failed: ["reconnecting", "closed"],
} as const;

/** Whether the machine may move from `from` to `to`. Self-transitions are no-ops. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true;
  return SESSION_TRANSITIONS[from].includes(to);
}

/** `"connected -> closed"`, for logs and assertion messages. */
export function describeTransition(from: SessionState, to: SessionState): string {
  return `${from} -> ${to}`;
}

/** Whether this state means a socket is open and audio will actually be sent. */
export function isLive(state: SessionState): boolean {
  return state === "connected";
}

/**
 * Whether the exam is between sockets but still expected to come back.
 *
 * The distinction the UI needs: this is the amber "l'épreuve continue" case,
 * whereas `failed` is the red one. Presenting the first as the second makes
 * candidates abandon a perfectly healthy exam.
 */
export function isRecovering(state: SessionState): boolean {
  return state === "reconnecting" || state === "resuming";
}

/**
 * The single status the rest of the app talks in — the seven values the issue
 * names, derived from the two machines rather than tracked as a third.
 *
 * Deriving it matters: a stored copy would be a third source of truth capable of
 * disagreeing with the phase clock, which is the one thing the exam flow is not
 * allowed to do.
 */
export type ExamStatus =
  | "preparation"
  | "monologue"
  | "debate"
  | "reconnecting"
  | "resuming"
  | "finished"
  | "error";

export const EXAM_STATUSES: readonly ExamStatus[] = [
  "preparation",
  "monologue",
  "debate",
  "reconnecting",
  "resuming",
  "finished",
  "error",
] as const;

/**
 * Flatten (phase, session) into one status.
 *
 * The precedence is the argument of the whole module, so it is spelled out:
 *
 *  1. **`finished` wins over everything.** The exam is over; whatever the socket
 *     is doing on its way down is not a state the candidate should be shown.
 *  2. **`preparation` ignores the session entirely.** No socket is open during
 *     preparation by design (`phaseUsesLiveSession`), so no connection state is
 *     a fact about it — not `idle`, and not a stale `failed` left over from
 *     nothing. A candidate writing their notes must never be shown a connection
 *     error for a connection that does not exist.
 *  3. **`error` wins over the speaking phase.** A `failed` session mid-débat is
 *     not a débat.
 *  4. **Recovery wins over the speaking phase.** During a reconnect the
 *     candidate is told the exam continues; the phase is still `debate`
 *     underneath, and the phase clock never stopped.
 */
export function examStatus(phase: OralPhase, session: SessionState): ExamStatus {
  if (phase === "finished") return "finished";
  if (phase === "preparation") return "preparation";
  if (session === "failed") return "error";
  if (session === "reconnecting") return "reconnecting";
  if (session === "resuming") return "resuming";
  return phase;
}
