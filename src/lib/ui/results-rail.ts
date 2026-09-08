/**
 * The correction's transcript rail — the numbers behind its resizable divider
 * (#190).
 *
 * PORT NOTE: `src/lib/orale-results.ts` in the main project (delf-preps@3901a2d6),
 * kept as a percentage of the split rather than the pixel width and 26.25 rem
 * floor #141's rail had before #183 deleted it. The share is the reader's
 * call — how much transcript they need beside the correction varies with what
 * they are checking — and it is a share rather than a width so the same number
 * means the same thing on a 1280 px laptop and a 1920 px monitor.
 *
 * Here rather than in the component so the clamp and the pointer arithmetic
 * are unit-tested rather than re-derived in a handler.
 */

/** The rail's starting share of the split, in percent. */
export const RESULTS_RAIL_DEFAULT_PCT = 35;

/**
 * How far the drag can go, in percent of the split. The floor keeps the
 * transcript a readable column rather than a sliver of wrapped words; the
 * ceiling keeps the correction the dominant pane, which is the reading the
 * layout exists for — past half, the page would invert back into the
 * transcript-first report the main project's retours asked to leave.
 */
export const RESULTS_RAIL_MIN_PCT = 22;
export const RESULTS_RAIL_MAX_PCT = 55;

/** How much one arrow press moves the divider, in percent. */
export const RESULTS_RAIL_KEY_STEP_PCT = 2;

/** A candidate rail share, clamped onto the legal range. */
export function clampRailPct(pct: number): number {
  if (Number.isNaN(pct)) return RESULTS_RAIL_DEFAULT_PCT;
  return Math.min(RESULTS_RAIL_MAX_PCT, Math.max(RESULTS_RAIL_MIN_PCT, pct));
}

/**
 * The rail share a pointer position asks for: the distance from the pointer to
 * the split's RIGHT edge, as a percent of its width — the rail is the right
 * column, so dragging the divider left grows it.
 */
export function railPctFromPointer(clientX: number, rect: { left: number; width: number }): number {
  if (rect.width <= 0) return RESULTS_RAIL_DEFAULT_PCT;
  return clampRailPct(((rect.left + rect.width - clientX) / rect.width) * 100);
}

/**
 * Where a key press on the focused divider leaves the rail. Left grows it
 * (the drag's own direction), right shrinks it, Home puts it back where it
 * rests. Anything else is not the divider's key and leaves it alone.
 */
export function railPctAfterKey(current: number, key: string): number {
  switch (key) {
    case "ArrowLeft":
      return clampRailPct(current + RESULTS_RAIL_KEY_STEP_PCT);
    case "ArrowRight":
      return clampRailPct(current - RESULTS_RAIL_KEY_STEP_PCT);
    case "Home":
      return RESULTS_RAIL_DEFAULT_PCT;
    default:
      return clampRailPct(current);
  }
}
