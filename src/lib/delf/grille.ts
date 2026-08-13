/**
 * DELF B2 grille primitives — the official 4-band scale shared by the production
 * écrite and production orale correctors.
 *
 * The France Éducation international corrector grids score every criterion on a
 * discrete **4-band scale — 0 / 1 / 3 / 5** — not a continuous 0–5. Each band is
 * a *performance level*, not just a number (see docs/GRILLES_B2_CORRECTION.md):
 *
 *   0 → Non répondu / production insuffisante
 *   1 → En dessous du niveau ciblé (below B2)
 *   3 → Au niveau ciblé (B2)
 *   5 → Au niveau ciblé supérieur (B2+)
 *
 * Five criteria × 5 = the /25 competency score. This module is pure and testable;
 * it is the single source of truth for the bands, their labels, and snapping a
 * model's raw number onto the nearest legal band.
 *
 * PORT NOTE: copied byte-for-byte from the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`, `src/lib/grille.ts`).
 * The reproduction audit marks this file "Reproduce": the tie-rounding rule
 * (2 → 1, 4 → 3) is a deliberate conservative reading of the grille that changes
 * real grades, so it must not be re-derived. Do not "improve" this file.
 */

/** The only legal per-criterion scores on the official grille. */
export const GRILLE_BANDS = [0, 1, 3, 5] as const;

export type GrilleBand = (typeof GRILLE_BANDS)[number];

/** Short French label for each band (results UI + prompt). */
export const BAND_LABELS: Record<GrilleBand, string> = {
  0: "Insuffisant",
  1: "En dessous du niveau B2",
  3: "Au niveau B2",
  5: "B2+",
};

/** A coarse tone bucket for colouring a band in the UI. */
export type BandTone = "red" | "amber" | "green" | "emerald";

export const BAND_TONE: Record<GrilleBand, BandTone> = {
  0: "red",
  1: "amber",
  3: "green",
  5: "emerald",
};

/**
 * Snap an arbitrary model number onto the nearest legal band {0, 1, 3, 5}. The
 * grille has no 2 or 4 — a model that emits one is nudged to the closest band
 * (ties round down, the more conservative DELF choice). Non-finite → 0.
 */
export function snapToBand(n: number): GrilleBand {
  if (!Number.isFinite(n)) return 0;
  let best: GrilleBand = 0;
  let bestDist = Infinity;
  for (const band of GRILLE_BANDS) {
    const dist = Math.abs(n - band);
    // strict `<` keeps the lower band on ties (e.g. 2 → 1, 4 → 3).
    if (dist < bestDist) {
      bestDist = dist;
      best = band;
    }
  }
  return best;
}

/** The band label for a raw score (snapped first). */
export function bandLabel(n: number): string {
  return BAND_LABELS[snapToBand(n)];
}
