import type { OralPhase } from "@/lib/delf/phases";

/**
 * When the development time-skip may be offered (#149, #203).
 *
 * Only while a speaking part is actually running and not closing: a skip on
 * an armed clock has nothing to move, and one during the closing handshake
 * would race the end it is asking for. The held monologue hides it too,
 * because `tick()` re-anchors a held clock and would silently undo the jump.
 * The controller refuses all of these anyway (`devMoveClock`); this is the
 * same rule, so the button is not shown where it would do nothing.
 */
export function devTimeSkipAvailable(state: {
  phase: OralPhase;
  phaseStartedAt: number | null;
  closing: boolean;
  monologueHeld: boolean;
}): boolean {
  if (state.phase !== "monologue" && state.phase !== "debate") return false;
  return state.phaseStartedAt !== null && !state.closing && !state.monologueHeld;
}
