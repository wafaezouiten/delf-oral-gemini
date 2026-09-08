/**
 * The phone's evaluation drawer on the correction — its geometry and the
 * decisions a gesture ends in (#190).
 *
 * PORT NOTE: the constants and the rules of `po-result-drawer.tsx` in the main
 * project (delf-preps@3901a2d6), lifted out of the component so they are tested
 * here rather than only on somebody's phone. The component owns the pointer
 * events and the DOM; this file owns every number it writes.
 *
 * The drawer is a panel `FULL_SHARE` of the viewport tall, translated down by
 * `y` pixels: `y = 0` is fully open, `y = closedY` leaves only the handle
 * showing. Position is free, not quantised — the reader parks it wherever suits
 * the criterion they are on — so most releases change nothing; only a flick
 * commits to an end, and only a tap that never moved toggles.
 */

/** The resting height a tap opens to, as a share of the viewport. */
export const DRAWER_DEFAULT_SHARE = 0.55;
/** How tall the panel can ever be, as a share of the viewport. */
export const DRAWER_FULL_SHARE = 0.92;
/** The handle's height in px — what stays visible when the drawer is closed. */
export const DRAWER_PEEK_PX = 56;
/**
 * How close to the default still counts as "already open at the default", so a
 * second tap closes rather than re-opening to where it already sits.
 */
export const DRAWER_AT_DEFAULT_TOLERANCE_PX = 72;
/** Movement past this many px makes a gesture a drag, never a tap. */
export const DRAWER_TAP_SLOP_PX = 6;
/** Past this speed (px/s) a release commits to fully open or fully closed. */
export const DRAWER_FLING_VELOCITY = 900;

export interface DrawerGeometry {
  /** The panel's height in px. */
  fullHeight: number;
  /** `y` at which only the handle shows. */
  closedY: number;
  /** `y` a tap opens to. */
  defaultY: number;
  /**
   * Whether there is anything to open into. A viewport short enough that
   * half of it is the handle has no default height above the closed one, and
   * the drawer then rests closed rather than claiming to be open.
   */
  canOpen: boolean;
}

export function drawerGeometry(
  viewportHeight: number,
  peekHeight: number = DRAWER_PEEK_PX,
): DrawerGeometry {
  const safeViewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  // Whole pixels: these are written to `transform` and compared against each
  // other, and a share of a viewport is a float that would otherwise leave a
  // drawer "at the default" one ten-thousandth of a pixel off it.
  const fullHeight = Math.round(safeViewport * DRAWER_FULL_SHARE);
  const closedY = Math.max(0, fullHeight - peekHeight);
  const defaultY = Math.max(0, fullHeight - Math.round(safeViewport * DRAWER_DEFAULT_SHARE));
  return { fullHeight, closedY, defaultY, canOpen: defaultY < closedY - 1 };
}

/** A candidate `y`, held inside the panel's travel. Hard clamp, not elastic:
 *  the drawer bottoms out against the screen edge, and an overscroll there reads
 *  as the panel coming loose. */
export function clampDrawerY(y: number, geometry: DrawerGeometry): number {
  if (Number.isNaN(y)) return geometry.closedY;
  return Math.min(geometry.closedY, Math.max(0, y));
}

/** Whether a `y` shows more than the handle. */
export function isDrawerOpen(y: number, geometry: DrawerGeometry): boolean {
  return y < geometry.closedY - 1;
}

/** How many px of the screen the drawer covers at `y`. */
export function drawerExposedHeight(y: number, geometry: DrawerGeometry): number {
  return Math.round(Math.max(0, geometry.fullHeight - clampDrawerY(y, geometry)));
}

/**
 * Where a drag release leaves the drawer: an end, when the release was a
 * flick, and otherwise exactly where the finger let go (`null` — the point of
 * free positioning). Velocity is px/s, positive downwards.
 */
export function drawerSettleAfterRelease(
  velocity: number,
  geometry: DrawerGeometry,
): number | null {
  if (velocity > DRAWER_FLING_VELOCITY) return geometry.closedY;
  if (velocity < -DRAWER_FLING_VELOCITY) return 0;
  return null;
}

/**
 * Where a tap on the handle sends the drawer: to the default height, or, when
 * it is already about there, back to the handle.
 */
export function drawerTapTarget(y: number, geometry: DrawerGeometry): number {
  if (!geometry.canOpen) return geometry.closedY;
  return Math.abs(y - geometry.defaultY) < DRAWER_AT_DEFAULT_TOLERANCE_PX
    ? geometry.closedY
    : geometry.defaultY;
}

/** Whether a gesture that has travelled `offset` px is a drag rather than a tap. */
export function isDrawerDrag(offset: number): boolean {
  return Math.abs(offset) > DRAWER_TAP_SLOP_PX;
}

/**
 * The release velocity of a gesture, in px/s, from its last few positions.
 *
 * Read off the samples inside the trailing window rather than off the whole
 * gesture, so a slow drag that ends with a flick is read as the flick, and a
 * flick that ends with the finger resting is read as the rest. A rest produces
 * no samples, so the caller stamps the release itself as the last one: then a
 * window with nothing in it but the release is no movement.
 */
export function drawerReleaseVelocity(
  samples: ReadonlyArray<{ time: number; y: number }>,
  windowMs = 100,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    if (last.time - samples[index].time > windowMs) break;
    first = samples[index];
  }
  const elapsed = last.time - first.time;
  if (elapsed <= 0) return 0;
  return ((last.y - first.y) / elapsed) * 1000;
}
