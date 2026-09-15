"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/ui/class-names";
import { DRAWER_PEEK_PX, drawerPanelBox } from "@/lib/ui/results-drawer";
import { useDrawerGestures, useDrawerPosition, useViewportHeight } from "./use-results-drawer";

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
 * where it is tested, and the hooks in `use-results-drawer.ts` attach it to
 * the DOM; this file draws.
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
  const viewport = useViewportHeight();
  const position = useDrawerPosition(viewport, initiallyOpen, onExposedHeightChange);
  const handle = useDrawerGestures(viewport, position);
  const { panelRef, bodyRef, isOpen } = position;
  const panelId = useId();

  return (
    <aside
      ref={panelRef}
      aria-label={label}
      data-open={isOpen}
      style={{
        // Sized and painted only once there is a viewport: `drawerPanelBox`.
        ...drawerPanelBox(viewport),
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
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={panelId}
        {...handle}
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
          is driven imperatively, to the visible slice of the drawer. */}
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
