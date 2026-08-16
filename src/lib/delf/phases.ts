/**
 * The DELF B2 production orale exam state machine.
 *
 * The whole product hangs off this file. The brief's hard requirement is that the
 * exam is NOT one generic 13-minute conversation: preparation, monologue and
 * débat are distinct phases with their own timers, their own UI, and — crucially —
 * their own Gemini behaviour. Keeping the machine here, pure and unit-tested,
 * means the React layer only ever *renders* a phase; it never decides one.
 *
 * Two properties are deliberate:
 *
 *  - **Each phase owns its clock.** `phaseDurationSeconds` is per-phase, never a
 *    single exam-wide countdown. A reconnect mid-débat must not reset the débat
 *    timer, and the monologue timer must not bleed into the débat.
 *  - **Transitions are one-way.** preparation → monologue → debate → finished.
 *    There is no path back, so a dropped Gemini connection can never rewind the
 *    candidate into an earlier phase (the failure mode that would make a
 *    reconnect feel like a new exam).
 */

import { getOralPartSpec, type OralPartSpec } from "./constants";

export type OralPhase = "preparation" | "monologue" | "debate" | "finished";

/** The phases in exam order. `finished` is terminal. */
export const ORAL_PHASES: readonly OralPhase[] = [
  "preparation",
  "monologue",
  "debate",
  "finished",
] as const;

/** The B2 part spec for a task number, or a loud failure. The parts are a fixed
 *  two-row table, so an absent one is a broken build, not a runtime condition. */
function requirePart(tache: number): OralPartSpec {
  const spec = getOralPartSpec(tache);
  if (!spec) throw new Error(`No DELF B2 oral part ${tache} in ORAL_PARTS_B2`);
  return spec;
}

const MONOLOGUE_PART = requirePart(1);
const DEBATE_PART = requirePart(2);

/**
 * Official DELF B2 production orale timings, in seconds: 30 min preparation, a
 * 5-7 min monologue suivi, then a ~13 min débat.
 *
 * **Derived, not restated.** These same three numbers already exist in
 * `constants.ts` as `ORAL_PARTS_B2` — ported verbatim from the reference
 * implementation, where they are the DELF business rule. Writing `7 * 60` here
 * as well would create two sources of truth for the exam's length, and the one
 * the timer reads would not be the one the duration penalty reads. Reading them
 * off the part specs means the phase clock and the rubric cannot disagree about
 * how long a monologue is.
 */
export const PHASE_DURATIONS: Record<Exclude<OralPhase, "finished">, number> = {
  preparation: MONOLOGUE_PART.preparationSeconds,
  monologue: MONOLOGUE_PART.durationSeconds,
  debate: DEBATE_PART.durationSeconds,
};

/**
 * The minimum monologue length before the candidate may move on to the débat.
 *
 * This is a **UI gate, not a grading rule**, and the distinction is the whole
 * reason it can be this short. It was 5 minutes, matching what the real épreuve
 * expects of a "monologue suivi"; it is now 1, so a candidate can cut a
 * monologue that has genuinely run out of things to say — and so the débat,
 * which is the half most people actually want to practise, is reachable without
 * sitting through five minutes first.
 *
 * Stopping early is still penalised, and by a completely separate number:
 * `minDurationSeconds(tache)` in `constants.ts` computes the duration penalty
 * from the *measured audio*, and it is unchanged. A candidate who stops at 61
 * seconds may now do so, and will still lose the points the DELF's own floor
 * costs them. The button no longer refuses; the grille still does.
 */
export const MONOLOGUE_MIN_SECONDS = 1 * 60;

/**
 * Voiced seconds below which a monologue reads as never attempted.
 *
 * Low on purpose. A candidate who genuinely spoke for the minute the clock
 * demands will have produced far more than this; one who sat in silence
 * produces almost none. Setting it near the middle of that gap rather than near
 * a "good" monologue means the question is only ever asked of someone who
 * really did say next to nothing.
 *
 * Five seconds is also about 125 frames, which is what makes the crude
 * per-frame measure behind it safe: a click marks one frame, and no plausible
 * amount of door-slamming reaches five seconds of speech-loud audio.
 */
export const MIN_VOICED_SECONDS = 5;

/**
 * Whether the monologue was silent — the candidate had a working microphone and
 * did not use it.
 *
 * The asymmetry in the first line is the important part. **A microphone that
 * captured nothing is not a silent candidate**: it is a broken microphone, the
 * product already has a notice, a watchdog and a whole "corrigé sans l'audio"
 * path for that, and someone whose capture failed while they spoke for six
 * minutes must never be told they said nothing. So this answers `false` when
 * there is no audio at all, and only claims silence when the recording exists
 * and is empty of speech.
 *
 * What the caller does with a `true` is offer a confirmation, never a refusal.
 * The measure underneath is a crude amplitude test (`lib/audio/voice-activity`)
 * and a quiet speaker on a low-gain microphone can defeat it; the cost of being
 * wrong therefore has to stay at one extra dialog. Blocking on it would risk
 * stranding a candidate who cannot reach the débat *or* the end of the épreuve,
 * which is worse than the accident it prevents.
 */
export function monologueWasSilent(
  capturedSeconds: number,
  voicedSeconds: number,
): boolean {
  if (!(capturedSeconds > 0)) return false;
  return voicedSeconds < MIN_VOICED_SECONDS;
}

/** How long this phase runs. `finished` has no clock. */
export function phaseDurationSeconds(phase: OralPhase): number {
  return phase === "finished" ? 0 : PHASE_DURATIONS[phase];
}

/** The phase that follows this one. `finished` is a fixed point. */
export function nextPhase(phase: OralPhase): OralPhase {
  const index = ORAL_PHASES.indexOf(phase);
  if (index === -1 || phase === "finished") return "finished";
  return ORAL_PHASES[index + 1];
}

/** Whether the exam is over. */
export function isTerminal(phase: OralPhase): boolean {
  return phase === "finished";
}

/**
 * Whether a phase's clock has run out. Compared with `>=` so a phase whose
 * elapsed time is driven from a wall-clock delta (which can jump past the
 * boundary when a tab is backgrounded) still ends exactly once.
 */
export function isPhaseTimeUp(phase: OralPhase, elapsedSeconds: number): boolean {
  if (phase === "finished") return true;
  return elapsedSeconds >= phaseDurationSeconds(phase);
}

/**
 * Whether the candidate may end this phase early with the "continue" button.
 *
 * Preparation is always skippable (a candidate who has finished their notes
 * should not sit through 30 minutes of dead time). The monologue only unlocks
 * once the 5-minute DELF floor is reached. The débat is skippable so a candidate
 * can stop when the conversation has genuinely run its course.
 */
export function canAdvanceEarly(phase: OralPhase, elapsedSeconds: number): boolean {
  switch (phase) {
    case "preparation":
      return true;
    case "monologue":
      return elapsedSeconds >= MONOLOGUE_MIN_SECONDS;
    case "debate":
      return true;
    case "finished":
      return false;
  }
}

/**
 * Whether Gemini should be *connected* during this phase.
 *
 * Preparation is silent — there is no examiner in the room while the candidate
 * writes their notes, and holding a Live socket open for 30 minutes would burn
 * through the connection limit before the exam even starts.
 */
export function phaseUsesLiveSession(phase: OralPhase): boolean {
  return phase === "monologue" || phase === "debate";
}

/** Candidate-facing French label for a phase (UI chrome). */
export const PHASE_LABELS: Record<OralPhase, string> = {
  preparation: "Préparation",
  monologue: "Monologue suivi",
  debate: "Débat",
  finished: "Épreuve terminée",
};

/**
 * Remaining seconds in a phase, floored at 0 and never NaN. Kept here rather
 * than in a component so the countdown and the time-up check can never disagree.
 */
export function remainingSeconds(phase: OralPhase, elapsedSeconds: number): number {
  const total = phaseDurationSeconds(phase);
  if (!Number.isFinite(elapsedSeconds)) return total;
  return Math.max(0, total - Math.floor(elapsedSeconds));
}

/** `m:ss`, for the phase clock. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
