/**
 * What the phase clock says out loud, and when.
 *
 * A countdown is the hardest thing on this screen to make accessible, because
 * the obvious implementation is the wrong one twice over. Marking the digits as
 * a live region announces a new time every second, which is unusable — a screen
 * reader would read nothing else for thirteen minutes. Marking them polite and
 * hoping for the best is the same thing with extra steps.
 *
 * So the digits are not a live region at all. They are announced on crossing a
 * milestone, and only then: a candidate who cannot see the clock hears "il reste
 * cinq minutes" at five minutes, the same information the sighted candidate gets
 * from glancing up, at roughly the same rate.
 *
 * Pure and separate from the component because the interesting behaviour is the
 * crossing rule, and the crossing rule has an edge case worth a test: a
 * backgrounded tab resumes with a clock that has jumped, so "remaining is
 * exactly 60" never happens and the announcement is missed. Crossings are
 * computed from an interval, not an equality.
 */

import { formatClock, type OralPhase } from "@/lib/delf/phases";

/**
 * The thresholds, in seconds remaining, most to least time.
 *
 * Chosen to be sparse early and dense late, which is how the information is
 * actually valuable: ten minutes into a débat nobody is pacing to the second,
 * and in the last thirty they are.
 */
export const CLOCK_MILESTONES: readonly number[] = [600, 300, 120, 60, 30, 0] as const;

/**
 * The milestone crossed between two readings of the clock, or null.
 *
 * "Crossed" means `previous` was strictly above it and `remaining` is at or
 * below it. When a jump crosses several — a tab that was asleep — the most
 * urgent one wins, because it is the one that is still true.
 *
 * A clock that went backwards (a new phase started, so `remaining` jumped up)
 * crosses nothing: the caller is expected to reset `previous` at a phase
 * boundary, and this is the second line of defence for when it does not.
 */
export function crossedMilestone(previous: number, remaining: number): number | null {
  if (!Number.isFinite(previous) || !Number.isFinite(remaining)) return null;
  if (remaining >= previous) return null;

  let crossed: number | null = null;
  for (const milestone of CLOCK_MILESTONES) {
    if (previous > milestone && remaining <= milestone) crossed = milestone;
  }
  return crossed;
}

/** `1 minute` / `5 minutes` / `30 secondes` — French agreement, not `1 minutes`. */
function spellDuration(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${seconds} secondes`;
}

/**
 * The sentence for a crossed milestone, in the phase's own terms.
 *
 * Named per phase because "il reste 30 secondes" means two different things to a
 * candidate: during preparation it is 30 seconds to finish their notes, during a
 * monologue it is 30 seconds of speaking left. The distinction is free here and
 * impossible to recover from the number alone.
 */
export function milestoneMessage(phase: OralPhase, milestone: number): string {
  if (milestone === 0) {
    switch (phase) {
      case "preparation":
        return "Temps de préparation écoulé. Le monologue commence.";
      case "monologue":
        return "Temps du monologue écoulé. Le débat commence.";
      case "debate":
        return "Temps du débat écoulé. L'épreuve se termine.";
      case "finished":
        return "Épreuve terminée.";
    }
  }

  const duration = spellDuration(milestone);
  switch (phase) {
    case "preparation":
      return `Il reste ${duration} de préparation.`;
    case "monologue":
      return `Il reste ${duration} de monologue.`;
    case "debate":
      return `Il reste ${duration} de débat.`;
    case "finished":
      return "Épreuve terminée.";
  }
}

/**
 * The full label for the clock, for the control's accessible name.
 *
 * Read on demand — when a candidate navigates to the clock — rather than
 * announced, which is what makes the milestone announcements above tolerable:
 * anyone who wants the exact time can go and get it at any moment.
 */
export function clockLabel(phase: OralPhase, remaining: number): string {
  const time = formatClock(remaining);
  switch (phase) {
    case "preparation":
      return `Préparation : ${time} restantes`;
    case "monologue":
      return `Monologue : ${time} restantes`;
    case "debate":
      return `Débat : ${time} restantes`;
    case "finished":
      return "Épreuve terminée";
  }
}

/**
 * The last minute of a speaking phase, where the clock changes appearance.
 *
 * Here rather than in the component so the badge, the word beside it and any
 * future use of it cannot disagree about when "urgent" starts. Preparation is
 * excluded: a candidate finishing their notes with a minute to go is not late,
 * they are on time.
 */
export const URGENT_SECONDS = 60;

export function isClockUrgent(phase: OralPhase, remaining: number): boolean {
  if (phase === "preparation" || phase === "finished") return false;
  return remaining <= URGENT_SECONDS;
}
