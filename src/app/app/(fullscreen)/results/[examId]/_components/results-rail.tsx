"use client";

import { useCallback, useRef, type RefObject } from "react";

import { cn } from "@/lib/ui/class-names";
import {
  RESULTS_RAIL_DEFAULT_PCT,
  RESULTS_RAIL_MAX_PCT,
  RESULTS_RAIL_MIN_PCT,
  clampRailPct,
  isRailKey,
  railPctAfterKey,
  railPctFromPointer,
} from "@/lib/ui/results-rail";

/**
 * The transcript rail's share of the split, and the two CSS variables the
 * split body carries.
 *
 * The divider writes `--po-rail` (the rail's share), the phone drawer writes
 * `--po-drawer-inset` (how much of the screen it covers). Both go through the
 * DOM rather than state — the divider reports on every pointer frame of a
 * drag, the drawer on every frame of its slide, and a render per frame is
 * what makes either stutter on a real machine. The ref keeps the rail's
 * current share for the keyboard path, which nudges relatively. The
 * arithmetic — clamping, the pointer's share, a key's step — is
 * `lib/ui/results-rail.ts`, tested; this is the DOM around it.
 */
export function useResultsRail() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef(RESULTS_RAIL_DEFAULT_PCT);
  const dragging = useRef(false);

  const setPct = useCallback((pct: number) => {
    const clamped = clampRailPct(pct);
    pctRef.current = clamped;
    bodyRef.current?.style.setProperty("--po-rail", `${clamped}%`);
    // aria-valuenow written the same way as the width: the ARIA
    // window-splitter pattern wants the current split announced after every
    // arrow press, and a render per drag frame is exactly what this avoids.
    handleRef.current?.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }, []);

  const onDrawerExposed = useCallback((height: number) => {
    bodyRef.current?.style.setProperty("--po-drawer-inset", `${height}px`);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // No text selection while dragging across the panes — and an explicit
    // focus, because `preventDefault` here swallows the focus-on-click Safari
    // would otherwise give it (#141).
    event.preventDefault();
    event.currentTarget.focus();
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = dragging.current ? bodyRef.current?.getBoundingClientRect() : undefined;
    if (rect) setPct(railPctFromPointer(event.clientX, rect));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onPointerCancel = () => {
    dragging.current = false;
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isRailKey(event.key)) return;
    event.preventDefault();
    setPct(railPctAfterKey(pctRef.current, event.key));
  };

  return {
    bodyRef,
    handleRef,
    onDrawerExposed,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
  };
}

/**
 * The divider between the two panes, desktop only: dragging it (or arrow
 * keys, once focused) resizes the transcript rail. An overlay centred on the
 * panes' shared hairline rather than a third grid track, so the grid stays
 * two columns; the visible line only paints on hover/focus — at rest the
 * aside's own border is the divider.
 */
export function ResultsRailDivider({
  ref,
  ...handlers
}: ReturnType<typeof useResultsRail>["handlers"] & { ref: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={ref}
      {...handlers}
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionner la transcription"
      aria-valuemin={RESULTS_RAIL_MIN_PCT}
      aria-valuemax={RESULTS_RAIL_MAX_PCT}
      aria-valuenow={RESULTS_RAIL_DEFAULT_PCT}
      tabIndex={0}
      style={{ right: `var(--po-rail, ${RESULTS_RAIL_DEFAULT_PCT}%)` }}
      className={cn(
        "no-print absolute inset-y-0 z-10 hidden w-2.5 translate-x-1/2 cursor-col-resize touch-none outline-none select-none lg:block",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-colors",
        "hover:after:bg-primary/40 focus-visible:after:bg-primary/60",
      )}
    />
  );
}
