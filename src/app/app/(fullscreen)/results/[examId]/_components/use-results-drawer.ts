"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  beginDrawerGesture,
  drawerFrame,
  drawerGeometry,
  drawerPlacementY,
  isDrawerOpen,
  moveDrawerGesture,
  releaseDrawerGesture,
  type DrawerGesture,
} from "@/lib/ui/results-drawer";

/**
 * The results drawer's machinery, in three hooks: the viewport it is sized
 * against, the position it is written to, and the gestures that move it.
 * Every number comes from `lib/ui/results-drawer.ts`, where it is tested;
 * these only attach it to the DOM, and the component only draws.
 */

/**
 * The *visual* viewport's height, so the drawer survives the mobile URL bar
 * collapsing: `dvh` in CSS would cover the height, but the drag maths needs
 * the number in JS too, and the two must agree or the drawer rests off-screen.
 * Zero until the first layout.
 */
export function useViewportHeight(): number {
  const [viewport, setViewport] = useState(0);
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
  return viewport;
}

export interface DrawerPosition {
  panelRef: RefObject<HTMLElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  /** Offset from fully open (0) down to closed, in px — the live position. */
  yRef: RefObject<number>;
  /** Mirrors the panel for what must re-render on it (aria, scrollability). */
  isOpen: boolean;
  openRef: RefObject<boolean>;
  setOpen: (open: boolean) => void;
  /** Write a position straight to the DOM; `animate` for a settle. */
  apply: (y: number, animate: boolean) => void;
  /** Move to `y` with the settle, and record whether that is open. */
  settle: (y: number) => void;
}

/**
 * Where the panel is. Position drives the transform without a render — this
 * runs on every frame of a drag, and a render per frame is what makes
 * dragging stutter on a real phone — and `isOpen` mirrors it for the things
 * that must re-render. `initiallyOpen` seeds both, so an auto-opened drawer's
 * body is scrollable and exposed to AT on its first paint, and fires once.
 */
export function useDrawerPosition(
  viewport: number,
  initiallyOpen: boolean,
  onExposedHeightChange?: (height: number) => void,
): DrawerPosition {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const openRef = useRef(initiallyOpen);
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const yRef = useRef(0);
  /** Whether the opening position has been applied — `initiallyOpen` fires once. */
  const placedRef = useRef(false);
  const lastExposedRef = useRef(-1);

  const setOpen = useCallback((open: boolean) => {
    openRef.current = open;
    setIsOpen(open);
  }, []);

  // The report is deduped to whole pixels: it re-lays-out the transcript
  // behind the drawer. The body is sized to the drawer's VISIBLE slice, so
  // its scroll range always covers exactly what is on screen — sized to the
  // panel instead, the last feedback panel would be unreachable until fully
  // open.
  const report = useCallback(
    (exposed: number, bodyHeight: string) => {
      if (exposed === lastExposedRef.current) return;
      lastExposedRef.current = exposed;
      if (bodyRef.current) bodyRef.current.style.height = bodyHeight;
      onExposedHeightChange?.(exposed);
    },
    [onExposedHeightChange],
  );

  const apply = useCallback(
    (y: number, animate: boolean) => {
      const panel = panelRef.current;
      if (!panel) return;
      const frame = drawerFrame(y, drawerGeometry(viewport), animate);
      yRef.current = frame.y;
      panel.style.transition = frame.transition;
      panel.style.transform = frame.transform;
      report(frame.exposed, frame.bodyHeight);
    },
    [viewport, report],
  );

  const settle = useCallback(
    (target: number) => {
      setOpen(isDrawerOpen(target, drawerGeometry(viewport)));
      apply(target, true);
    },
    [apply, setOpen, viewport],
  );

  // Place the drawer on the first layout that has a viewport to measure, then
  // keep its position correct when the viewport changes under it — the rule
  // is `drawerPlacementY`. `openRef` rather than `isOpen` so this runs on a
  // layout change, not on a state change. On a viewport too short to open
  // into, `isOpen` is left seeded and corrects itself on the first gesture:
  // the body it exposes is sized to the visible slice, which is then nothing.
  useEffect(() => {
    if (!viewport) return;
    // Force the next report through: the geometry changed, so the cached
    // exposed height no longer describes the same layout.
    lastExposedRef.current = -1;
    const first = !placedRef.current;
    placedRef.current = true;
    apply(
      drawerPlacementY(
        { first, initiallyOpen, open: openRef.current, y: yRef.current },
        drawerGeometry(viewport),
      ),
      false,
    );
  }, [viewport, initiallyOpen, apply]);

  // Closing returns the body to the top, so re-opening starts at the score
  // rather than resuming a scroll position left behind three criteria down.
  useEffect(() => {
    if (!isOpen) bodyRef.current?.scrollTo({ top: 0 });
  }, [isOpen]);

  return { panelRef, bodyRef, yRef, isOpen, openRef, setOpen, apply, settle };
}

type PointerHandler = (event: React.PointerEvent<HTMLDivElement>) => void;

export interface DrawerHandleProps {
  onPointerDown: PointerHandler;
  onPointerMove: PointerHandler;
  onPointerUp: PointerHandler;
  onPointerCancel: PointerHandler;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * The handle's gestures: a drag that is applied frame by frame, a release
 * that flicks to an end or stays put, a tap, and the keyboard parity for the
 * tap — dragging is pointer-only, so without it the drawer could not be
 * opened without a touchscreen or mouse.
 */
export function useDrawerGestures(viewport: number, position: DrawerPosition): DrawerHandleProps {
  const { yRef, openRef, setOpen, apply, settle } = position;
  const gestureRef = useRef<DrawerGesture | null>(null);

  const onPointerDown: PointerHandler = (event) => {
    if (!viewport) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = beginDrawerGesture(
      event.pointerId,
      event.clientY,
      yRef.current,
      event.timeStamp,
    );
  };

  const onPointerMove: PointerHandler = (event) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    apply(
      moveDrawerGesture(gesture, event.clientY, event.timeStamp, drawerGeometry(viewport)),
      false,
    );
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

  const onPointerUp: PointerHandler = (event) => {
    const gesture = release(event);
    if (!gesture) return;
    const geometry = drawerGeometry(viewport);
    const target = releaseDrawerGesture(gesture, yRef.current, event.timeStamp, geometry);
    if (target !== null) settle(target);
    // Otherwise it simply stays where it was released — that is the point.
    else setOpen(isDrawerOpen(yRef.current, geometry));
  };

  const onPointerCancel: PointerHandler = (event) => {
    if (!release(event)) return;
    setOpen(isDrawerOpen(yRef.current, drawerGeometry(viewport)));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const geometry = drawerGeometry(viewport);
    settle(openRef.current ? geometry.closedY : geometry.defaultY);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown };
}
