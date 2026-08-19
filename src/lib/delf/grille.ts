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
 * PORT NOTE: the per-criterion half of this file — everything down to
 * `bandLabel` — is copied byte-for-byte from the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`, `src/lib/grille.ts`).
 * The reproduction audit marks it "Reproduce": the tie-rounding rule (2 → 1,
 * 4 → 3) is a deliberate conservative reading of the grille that changes real
 * grades, so it must not be re-derived. Do not "improve" that half.
 *
 * The `/25` scale at the foot of the file is this project's own and has no
 * counterpart in the reference. It is additive — it reads none of the ported
 * values and changes none of them — and it lives here rather than in a file of
 * its own because it is the counterpart of `BAND_TONE`: the same question, asked
 * of the total instead of of one criterion. Two files owning "what colour is
 * this mark" is how the two answers drift apart (#50).
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

/* ---------------------------------------------------------------------------
 * The /25 total, on a five-step scale.
 *
 * The five criteria above are graded on four bands and coloured accordingly.
 * The number they add up to — the one figure the whole épreuve reduces to — was
 * coloured pass/fail from `meetsCompetencyFloor`, so 6/25 and 24/25 were both
 * green. This is the /25's own gradation (#50).
 *
 * Two things about it are deliberate and are not to be tidied:
 *
 *  - **The first band holds six marks and the rest hold five.** 0–5 · 6–10 ·
 *    11–15 · 16–20 · 21–25, as specified. It is not an off-by-one: it puts the
 *    whole éliminatoire range *and the floor itself* in the reddest band.
 *  - **This is a tint, not a verdict.** `meetsCompetencyFloor` still decides
 *    whether a sitting is éliminatoire, and 5/25 clears that floor while sitting
 *    in the red band. Both statements are true and the results page prints both.
 *
 * There is no `BAND_LABELS` counterpart here, and that is the difference between
 * this scale and the per-criterion one. A band on the grille needs a name because
 * « 3 » on a scale of 0 · 1 · 3 · 5 means nothing to a candidate who has not read
 * the grid; a /25 needs none because the mark is already the message. The tone is
 * a redundant encoding of a number printed in full beside it, so nothing is lost
 * in greyscale, on a mono printer, or under the print block's flattened fills —
 * « 12/25 » says the same thing in every one of them.
 * ------------------------------------------------------------------------- */

/** A coarse tone bucket for colouring a /25. Five steps, rouge → vert. */
export type ScoreTone = "red" | "coral" | "orange" | "yellow" | "green";

export interface ScoreBand {
  /** The lowest /25 that falls in this band. */
  min: number;
  tone: ScoreTone;
}

/**
 * The five bands, highest first — the order `scoreBand` walks, so the table
 * reads the way the lookup runs.
 */
export const SCORE_BANDS: readonly ScoreBand[] = [
  { min: 21, tone: "green" },
  { min: 16, tone: "yellow" },
  { min: 11, tone: "orange" },
  { min: 6, tone: "coral" },
  { min: 0, tone: "red" },
];

/** The reddest band, and the answer for anything that is not a mark. */
const LOWEST_BAND = SCORE_BANDS[SCORE_BANDS.length - 1];

/**
 * Which band a /25 falls in.
 *
 * Guarded the way `snapToBand` is, because the same two things can reach it: a
 * non-finite number (→ the lowest band, since a mark that cannot be read is not
 * a good one) and a number outside 0–25. Above 25 lands in `green` and below 0
 * in `red` by the walk itself, so neither needs a clamp.
 *
 * Fractions are not marks but the dashboard's average is one, and it is on this
 * scale too. A 5.5 average is red: the boundary is at 6, not at "nearly 6".
 */
export function scoreBand(score25: number): ScoreBand {
  if (!Number.isFinite(score25)) return LOWEST_BAND;
  for (const band of SCORE_BANDS) {
    if (score25 >= band.min) return band;
  }
  return LOWEST_BAND;
}

/**
 * The tone for a /25 — what every surface that only paints a number asks for.
 *
 * `scoreBand` is for the one caller that carries the band itself: the dashboard's
 * view model, which computes it from a number the component never sees.
 */
export function scoreTone(score25: number): ScoreTone {
  return scoreBand(score25).tone;
}
