import { COMPETENCY_MAX } from "@/lib/delf/constants";
import type { ScoreBand } from "@/lib/delf/grille";
import {
  formatScoreDelta,
  type TrajectoryPoint,
  type TrajectoryView,
} from "@/lib/ui/dashboard-view";

/** The headline's movement since the simulation before: a direction, never a band. */
export interface TrajectoryDelta {
  text: string;
  tone: "up" | "down" | "flat";
  /** The caret the sign rides on — none for « ±0 pt », which has no direction. */
  caret: string | null;
}

export interface TrajectoryHeadline {
  /** The newest simulation: the card's headline note, tinted on its band. */
  latest: { score25: number; band: ScoreBand; date: string };
  /** Latest minus the simulation before, or null with one data point. */
  delta: TrajectoryDelta | null;
  /** « dernière simulation · 4 août », or « première » when there is nothing before it. */
  dateLine: string;
  /** The x-axis's right end — the latest date, or null when it is also the first. */
  axisEnd: string | null;
}

/**
 * What « Votre trajectoire » says above the bars (#143, #234). Null on an
 * empty record: the card does not render at all.
 */
export function trajectoryHeadline(trajectory: TrajectoryView): TrajectoryHeadline | null {
  const { points, latest, delta } = trajectory;
  if (!latest) return null;
  const movement = delta === null ? null : deltaView(delta);
  return {
    latest,
    delta: movement,
    dateLine: `${movement ? "dernière" : "première"} simulation · ${latest.date}`,
    axisEnd: points.length > 1 ? latest.date : null,
  };
}

function deltaView(delta: number): TrajectoryDelta {
  const text = formatScoreDelta(delta);
  if (delta > 0) return { text, tone: "up", caret: "▲ " };
  if (delta < 0) return { text, tone: "down", caret: "▼ " };
  return { text, tone: "flat", caret: null };
}

/**
 * Where a bar anchors its tooltip: the first and last bars to their own side
 * instead of their centre, so the sujets at the edges do not run out of the
 * card.
 */
export function barAlign(
  index: number,
  count: number,
): "left-0" | "right-0" | "left-1/2 -translate-x-1/2" {
  if (index === 0) return "left-0";
  if (index === count - 1) return "right-0";
  return "left-1/2 -translate-x-1/2";
}

export interface TrajectoryBarView {
  /** The bar's height, as a share of the /25 — undefined for a walk-out's zero. */
  style: { height: string } | undefined;
  /** A walk-out's 0/25 still shows: a red sliver on the floor beats an invisible bar. */
  sliver: boolean;
  /** What a focused bar reads aloud: the tooltip, in one line. */
  srText: string;
  /** The tooltip's third line — only for a walk-out. */
  note: string | null;
}

/** One bar, as the chart draws it. */
export function trajectoryBar(point: TrajectoryPoint): TrajectoryBarView {
  const abandoned = point.outcome === "abandoned";
  return {
    style: point.percent > 0 ? { height: `${point.percent}%` } : undefined,
    sliver: point.percent === 0,
    srText: `${point.topicTitle} — ${point.score25}/${COMPETENCY_MAX}, ${point.date}${abandoned ? ", épreuve abandonnée" : ""}`,
    note: abandoned ? "Épreuve abandonnée" : null,
  };
}
