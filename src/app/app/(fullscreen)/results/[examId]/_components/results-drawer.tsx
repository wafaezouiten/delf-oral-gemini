"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/ui/class-names";
import {
  DRAWER_PEEK_PX,
  clampDrawerY,
  drawerExposedHeight,
  drawerGeometry,
  drawerReleaseVelocity,
  drawerSettleAfterRelease,
  drawerTapTarget,
  isDrawerDrag,
  isDrawerOpen,
} from "@/lib/ui/results-drawer";

/**
 * The phone's evaluation surface on the correction (#190): a non-modal bottom
 * drawer holding the verdict, the five criteria and the feedback panels, while
 * the transcript keeps the full screen behind it.
 *
 * PORT NOTE: `po-result-drawer.tsx` in the main project (delf-preps@3901a2d6),
 * with one substitution. The main project moves the panel with `motion` — a
 * motion value for the drag and a spring for the settle. This project has no
 * animation dependency and is not taking one on for one panel: the drag writes
 * `transform` straight to the DOM on every pointer frame, exactly as the main
 * project's motion value did, and the settle is a CSS transition that is
 * switched on for the release and off again for the next drag. The
 * reduced-motion rule in `globals.css` already collapses that transition, so a
 * candidate who asked for less motion gets the panel placed rather than slid.
 * Every number the panel is written to comes from `lib/ui/results-drawer.ts`,
 * where it is tested.
 *
 * **Why a drawer.** Below `lg` a two-pane report collapses to one column, and
 * the evaluation then stacks under the whole transcript: reading a criterion's
 * justification and finding the sentence it judges means scrolling the entire
 * transcript between the two, every time. On a correction that comparison IS
 * the task. So the transcript keeps the screen and the evaluation floats over
 * it, where both are reachable at once.
 *
 * **The drag model.** The drawer is one rigid panel; the handle is the drag
 * surface and the tap target, and the body below it scrolls on its own.
 * Position is free, not quantised — the reader parks the panel wherever suits
 * the criterion they are on. Releasing keeps that height; only a fast flick
 * commits to fully open or shut. One tap on the handle opens to the default
 * height, or drops back to the bar if it is already about there — decided on
 * pointer-up and only for a gesture that never moved, so a drag release is
 * never read as a tap.
 *
 * `initiallyOpen` is the one time it moves on its own, and it fires once: the
 * correction opens at the default height because the évaluation is what
 * finishing the épreuve asked for.
 *
 * Phone-only (`lg:hidden`) and never printed: from `lg` the report renders its
 * real two-pane split, and on paper the évaluation is printed once, by the pane.
 */

/** The settle: fast out of the finger, soft into place. */
const SETTLE_TRANSITION = "transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)";

interface Gesture {
  pointerId: number;
  startClientY: number;
  startY: number;
  moved: boolean;
  samples: Array<{ time: number; y: number }>;
}

export function ResultsDrawer({
  label,
  readout,
  onExposedHeightChange,
  initiallyOpen = false,
  children,
}: {
  /** Kicker on the handle, e.g. « Évaluation ». */
  label: string;
  /**
   * The right-hand readout on the handle. It stays visible at every height,
   * so once the reader closes the drawer over the transcript it is still the
   * score on screen — which is what lets the closed state hide the criteria
   * without also hiding the headline result.
   */
  readout?: ReactNode;
  /**
   * Called with how many px of the screen the drawer covers, as it moves. The
   * transcript turns this into bottom padding so its tail can always be
   * scrolled clear of the drawer. Fires on every pointer frame of a drag, so
   * the receiver writes it to the DOM rather than to React state.
   */
  onExposedHeightChange?: (height: number) => void;
  /** Rest at the default height on arrival instead of closed. Applies once. */
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [viewport, setViewport] = useState(0);
  // Mirrors the panel's position for the things that must re-render on it
  // (aria, the body's scrollability). The position itself drives the transform
  // without a render. Seeded from `initiallyOpen` so an auto-opened drawer's
  // body is scrollable and exposed to AT on its first paint.
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const openRef = useRef(initiallyOpen);
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  /** Offset from fully open (0) down to closed, in px. */
  const yRef = useRef(0);
  /** Whether the opening position has been applied — `initiallyOpen` fires once. */
  const placedRef = useRef(false);
  const gestureRef = useRef<Gesture | null>(null);
  const lastExposedRef = useRef(-1);
  const panelId = useId();

  const setOpen = useCallback((open: boolean) => {
    openRef.current = open;
    setIsOpen(open);
  }, []);

  // Sized against the *visual* viewport so it survives the mobile URL bar
  // collapsing: `dvh` in CSS would cover the height, but the drag maths needs
  // the number in JS too, and the two must agree or the drawer rests off-screen.
  useEffect(() => {
    const read = () => setViewport(window.visualViewport?.height ?? window.innerHeight);
    read();
    const visual = window.visualViewport;
    visual?.addEventListener("resize", read);
    window.addEventListener("resize", read);
    return () => {
      visual?.removeEventListener("resize", read);
      window.removeEventListener("resize", read);
    };
  }, []);

  /**
   * Write a position to the panel, and report the slice of screen it covers.
   * Both go straight to the DOM: this runs on every frame of a drag, and a
   * render per frame is what makes dragging stutter on a real phone. The
   * report is deduped to whole pixels for the same reason — it re-lays-out the
   * transcript behind the drawer.
   */
  const apply = useCallback(
    (y: number, animate: boolean) => {
      const panel = panelRef.current;
      if (!panel) return;
      const geometry = drawerGeometry(viewport);
      const clamped = clampDrawerY(y, geometry);
      yRef.current = clamped;
      panel.style.transition = animate ? SETTLE_TRANSITION : "none";
      panel.style.transform = `translateY(${clamped}px)`;

      const exposed = drawerExposedHeight(clamped, geometry);
      if (exposed === lastExposedRef.current) return;
      lastExposedRef.current = exposed;
      // The body is sized to the drawer's VISIBLE slice, so its scroll range
      // always covers exactly what is on screen. Sized to the panel instead,
      // the last feedback panel would be unreachable until fully open.
      const body = bodyRef.current;
      if (body) body.style.height = `${Math.max(0, exposed - DRAWER_PEEK_PX)}px`;
      onExposedHeightChange?.(exposed);
    },
    [viewport, onExposedHeightChange],
  );

  const settle = useCallback(
    (target: number) => {
      setOpen(isDrawerOpen(target, drawerGeometry(viewport)));
      apply(target, true);
    },
    [apply, setOpen, viewport],
  );

  // Place the drawer on the first layout that has a viewport to measure, then
  // keep the closed position correct when the viewport changes under it. An
  // open drawer is left where the reader put it — only its lower limit is
  // re-clamped. `openRef` rather than `isOpen` so this is a re-clamp on layout
  // change, not a snap on state change.
  useEffect(() => {
    if (!viewport) return;
    const geometry = drawerGeometry(viewport);
    // Force the next report through: the geometry changed, so the cached
    // exposed height no longer describes the same layout.
    lastExposedRef.current = -1;

    if (!placedRef.current) {
      placedRef.current = true;
      // A viewport too short to open into rests closed instead. `isOpen` is
      // left seeded and corrects itself on the first gesture: the body it
      // exposes is sized to the visible slice, which is then nothing.
      if (initiallyOpen && geometry.canOpen) {
        apply(geometry.defaultY, false);
        return;
      }
    }

    if (!openRef.current) apply(geometry.closedY, false);
    else apply(Math.min(yRef.current, geometry.closedY), false);
  }, [viewport, initiallyOpen, apply]);

  // Closing returns the body to the top, so re-opening starts at the score
  // rather than resuming a scroll position left behind three criteria down.
  useEffect(() => {
    if (!isOpen) bodyRef.current?.scrollTo({ top: 0 });
  }, [isOpen]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!viewport) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startY: yRef.current,
      moved: false,
      samples: [{ time: event.timeStamp, y: yRef.current }],
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const offset = event.clientY - gesture.startClientY;
    // Any real movement makes this gesture a drag, so its release cannot count
    // as a tap.
    if (isDrawerDrag(offset)) gesture.moved = true;
    const y = clampDrawerY(gesture.startY + offset, drawerGeometry(viewport));
    apply(y, false);
    gesture.samples.push({ time: event.timeStamp, y });
    if (gesture.samples.length > 8) gesture.samples.shift();
  };

  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return null;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return gesture;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = release(event);
    if (!gesture) return;
    const geometry = drawerGeometry(viewport);
    if (!gesture.moved) {
      settle(drawerTapTarget(yRef.current, geometry));
      return;
    }
    // The release itself is the last sample: a finger that stopped and then
    // lifted produced no moves since it stopped, and without this stamp its
    // last movement would still read as the release speed.
    gesture.samples.push({ time: event.timeStamp, y: yRef.current });
    const target = drawerSettleAfterRelease(drawerReleaseVelocity(gesture.samples), geometry);
    if (target !== null) settle(target);
    // Otherwise it simply stays where it was released — that is the point.
    else setOpen(isDrawerOpen(yRef.current, geometry));
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!release(event)) return;
    setOpen(isDrawerOpen(yRef.current, drawerGeometry(viewport)));
  };

  // Keyboard parity for the tap: dragging is pointer-only, so without this the
  // drawer could not be opened without a touchscreen or mouse.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const geometry = drawerGeometry(viewport);
    settle(openRef.current ? geometry.closedY : geometry.defaultY);
  };

  const fullHeight = drawerGeometry(viewport).fullHeight;

  return (
    <aside
      ref={panelRef}
      aria-label={label}
      data-open={isOpen}
      style={{
        height: fullHeight || undefined,
        // Painted only once there is a viewport to place it against: before
        // that the panel has no height and no position, and a frame of it at
        // the top of the screen is the flash this hides.
        visibility: viewport ? undefined : "hidden",
        // Promote the panel to its own compositor layer so dragging it is a
        // transform on an existing layer rather than a repaint of the
        // transcript behind it.
        willChange: "transform",
      }}
      className={cn(
        "no-print border-border bg-background fixed inset-x-0 bottom-0 z-40 flex flex-col",
        "sheet rounded-t-lg border-t shadow-[0_-8px_32px_-12px_rgb(0_0_0/0.18)]",
        // A shadow rather than a hairline alone: this is a floating surface
        // over live content, which is the one place the product allows one.
        "lg:hidden",
      )}
    >
      {/* The handle: drag surface, tap target, and the score readout.
          `touch-none` here only — the body below keeps its own touch
          scrolling. `role="button"` with a key handler rather than a real
          <button>, because a button that owns a drag fires its click on every
          release. */}
      <div
        ref={handleRef}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        style={{ height: DRAWER_PEEK_PX }}
        className="flex w-full shrink-0 cursor-grab touch-none flex-col items-center justify-center gap-1.5 px-5 select-none active:cursor-grabbing"
      >
        <span className="bg-border h-1 w-9 shrink-0 rounded-full" aria-hidden />
        <span className="flex w-full items-center justify-between gap-3">
          <span className="text-muted-foreground shrink-0 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
            {label}
          </span>
          {readout && (
            <span className="text-muted-foreground tabular min-w-0 truncate text-[0.6875rem] font-semibold">
              {readout}
            </span>
          )}
        </span>
      </div>

      {/* `overscroll-contain` stops a flick at the end of the criteria from
          scrolling the transcript underneath — the two scrollers are stacked,
          and chaining between them reads as the drawer "leaking". The height
          is driven imperatively above, to the visible slice of the drawer. */}
      {/* `inert` rather than `aria-hidden` alone. The closed drawer clips its
          content to nothing, but the criterion buttons inside are still real
          buttons: without this a keyboard user tabs into a zero-height panel
          with no visible focus, and `aria-hidden` over focusable descendants is
          the ARIA anti-pattern that leaves what a screen reader does with them
          undefined. `inert` takes them out of the tab order and out of the
          accessibility tree together, which is the one thing that is true of a
          drawer resting as a bar. */}
      <div
        ref={bodyRef}
        id={panelId}
        inert={!isOpen}
        className={cn(
          "shrink-0 overscroll-contain",
          isOpen ? "overflow-y-auto" : "overflow-hidden",
        )}
      >
        {children}
      </div>
    </aside>
  );
}
