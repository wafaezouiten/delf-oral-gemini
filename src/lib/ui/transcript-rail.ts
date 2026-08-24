/**
 * The transcript rail's width, when the candidate pulls it open (#141).
 *
 * #136 put the transcript in a fixed 26.25 rem rail, which is right for
 * glancing and wrong for reading seven minutes of monologue. The rail's edge
 * is therefore a handle: pull it left and the rail widens, push it back and it
 * narrows, never below the width it opens at. This module is the arithmetic of
 * that gesture — what a pointer position means, where the width stops — kept
 * out of the component for the same reason `correction-transcript.ts` is:
 * everything decided rather than drawn should be reachable by `node --test`.
 *
 * The two caps are facts about the page, not taste:
 *
 *  - **Wider than the transcript's own measure buys nothing.** The article
 *    inside the rail is capped at 42.5 rem (`max-w-[42.5rem]`) so its lines
 *    stay readable; past that plus its gutters, pulling further only adds
 *    empty ground. The cap is where the pull stops meaning anything.
 *  - **The evaluation must keep a readable column.** It is the page's main
 *    pane (#136), and a pull that squeezed the /25 and the criteria into a
 *    sliver would invert the very hierarchy the swap established. So the rail
 *    also stops where the evaluation's minimum begins, whichever cap binds
 *    first.
 *
 * Everything is in CSS pixels, because that is the unit pointer events and
 * `getBoundingClientRect` speak.
 */

/** Where the rail opens, and the floor it can never be pushed below —
 *  26.25 rem, the width #136 chose for it. */
export const RAIL_DEFAULT_PX = 420;

/**
 * Past this the pull stops meaning anything: the article's 42.5 rem measure
 * (680 px) plus the rail's own gutters is fully served, and what would grow is
 * the margin around it.
 */
export const RAIL_CONTENT_MAX_PX = 720;

/** The narrowest the evaluation pane may be left — 24 rem, enough for the
 *  verdict card and a criterion row to stay themselves. */
export const EVALUATION_MIN_PX = 384;

/** One keyboard step on the handle. Coarse enough that widening by keyboard is
 *  a few presses, fine enough to place the edge deliberately. */
export const RAIL_KEY_STEP_PX = 32;

/**
 * The widest the rail may be pulled inside a body of `containerWidth` pixels.
 *
 * Never below {@link RAIL_DEFAULT_PX}: on a container too narrow for both caps
 * the rail simply stops being resizable, which is also what the phone layout
 * does by stacking — a floor above the ceiling would otherwise let a "clamp"
 * return widths the container cannot hold.
 */
export function railMaxPx(containerWidth: number): number {
  return Math.max(
    RAIL_DEFAULT_PX,
    Math.min(RAIL_CONTENT_MAX_PX, containerWidth - EVALUATION_MIN_PX),
  );
}

/** A wanted width, held between the floor and whichever cap binds first. */
export function clampRailPx(wanted: number, containerWidth: number): number {
  return Math.min(Math.max(wanted, RAIL_DEFAULT_PX), railMaxPx(containerWidth));
}

/**
 * The width a pointer at `clientX` is asking for, inside a body whose right
 * edge is at `containerRight`.
 *
 * The rail hangs off the body's right edge, so the wanted width is the
 * distance from the pointer to that edge — measured against the BODY's
 * rectangle rather than the viewport, because the two differ by whatever
 * chrome the shell puts around the page.
 */
export function railPxFromPointer(
  clientX: number,
  containerRight: number,
  containerWidth: number,
): number {
  return clampRailPx(containerRight - clientX, containerWidth);
}

/**
 * One keyboard step from `current`, clamped like every other route to a width.
 * "wider" is ArrowLeft on the handle — the edge moves left, the rail grows —
 * which is the mapping the drag itself teaches.
 */
export function steppedRailPx(
  current: number,
  direction: "wider" | "narrower",
  containerWidth: number,
): number {
  const delta = direction === "wider" ? RAIL_KEY_STEP_PX : -RAIL_KEY_STEP_PX;
  return clampRailPx(current + delta, containerWidth);
}
