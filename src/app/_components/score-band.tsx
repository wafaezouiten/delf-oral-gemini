import { tagShape } from "@/app/_components/po/tag";
import { COMPETENCY_MAX } from "@/lib/delf/constants";
import { scoreTone, type ScoreTone } from "@/lib/delf/grille";
import { cn } from "@/lib/ui/class-names";
import { formatScore25 } from "@/lib/ui/format-score";

/**
 * A /25, drawn on the five-step scale — the total's counterpart to `BandScale`.
 *
 * Every /25 the product prints comes through here: the results verdict, the
 * dashboard's rows and its « Note moyenne » tile, the historique, and the two
 * catalogues' last score. Before #50 they were coloured pass/fail from
 * `meetsCompetencyFloor`, so a 6/25 and a 24/25 were the same green.
 *
 * The three rules are `BandScale`'s, for the same reasons:
 *
 *  - **The colour comes from `grille.ts`.** `scoreTone` is the source of the
 *    tone; the only thing this file owns is which CSS token that tone maps to.
 *    `TONE_CLASSES` is keyed by `ScoreTone`, so a tone added to the scale fails
 *    the build here instead of quietly rendering grey.
 *  - **No caller decides a band.** They pass a number and get a tone; none of
 *    them knows where 15 becomes 16.
 *  - **The colour is never the message — the mark is.** No band name is printed
 *    beside the figure, and none is needed: unlike a « 3 » on the grille's
 *    0 · 1 · 3 · 5 scale, a /25 reads on its own. The tint is a redundant
 *    encoding of the number it sits on, so greyscale, a mono printer and the
 *    print block's flattened fills all lose the colour and keep the whole
 *    message.
 */
const TONE_CLASSES: Record<ScoreTone, { fill: string; ink: string; ring: string }> = {
  red: { fill: "bg-score-red-subtle", ink: "text-score-red", ring: "border-score-red/40" },
  coral: {
    fill: "bg-score-coral-subtle",
    ink: "text-score-coral",
    ring: "border-score-coral/40",
  },
  orange: {
    fill: "bg-score-orange-subtle",
    ink: "text-score-orange",
    ring: "border-score-orange/40",
  },
  yellow: {
    fill: "bg-score-yellow-subtle",
    ink: "text-score-yellow",
    ring: "border-score-yellow/40",
  },
  green: {
    fill: "bg-score-green-subtle",
    ink: "text-score-green",
    ring: "border-score-green/40",
  },
};

/**
 * The band's solid fill, for a /25 drawn as a shape rather than printed — the
 * trajectory chart's bars. Solid rather than `-subtle` because a bar is read
 * against the card, not written on: the subtle steps flatten to the surface at
 * a bar's size, and the height already carries the figure for anyone who
 * cannot see the hue.
 */
const FILL_CLASSES: Record<ScoreTone, string> = {
  red: "bg-score-red",
  coral: "bg-score-coral",
  orange: "bg-score-orange",
  yellow: "bg-score-yellow",
  green: "bg-score-green",
};

export function scoreFill(tone: ScoreTone): string {
  return FILL_CLASSES[tone];
}

/**
 * The band's ink for a /25 that is printed as a figure rather than as a pill —
 * the results page's big numeral and the dashboard tile.
 *
 * Keyed by tone rather than taking the score, so the caller that already has the
 * band (the dashboard's view model computed it) does not look it up twice and
 * the two cannot disagree.
 */
export function scoreInk(tone: ScoreTone): string {
  return TONE_CLASSES[tone].ink;
}

/**
 * The band worn by a whole surface rather than a pill — the sujet cards (#188),
 * which take their last score's fill and ring so a grid of them reads at a
 * glance. The ink is deliberately not part of it: the card's own text stays on
 * the foreground and the muted tokens, both of which hold AA on every one of
 * the five subtle fills (see the `--score-*` block in `globals.css`), and a
 * whole paragraph set in the band's ink would be colour doing the talking.
 */
export function scoreSurface(score25: number): string {
  const tone = TONE_CLASSES[scoreTone(score25)];
  return cn(tone.fill, tone.ring);
}

/**
 * The pill inverted: the band's solid fill under white text, for a pill that
 * sits on a surface already wearing the band's tint (`scoreSurface`), where the
 * tinted pill would be a ring on its own colour. Every ink holds ≥ 6.2:1 under
 * white. On paper it falls back to an outline, since a mono printer that drops
 * fills would otherwise print white text on nothing.
 */
const SOLID_CLASSES: Record<ScoreTone, string> = {
  red: "bg-score-red",
  coral: "bg-score-coral",
  orange: "bg-score-orange",
  yellow: "bg-score-yellow",
  green: "bg-score-green",
};
const solidInk =
  "border-transparent text-white print:border-current print:bg-transparent print:text-foreground";

/**
 * A /25 as a pill, tinted on its band.
 *
 * `mark` is the floor's verdict (`✓` / `✕`) where a surface shows one, and it is
 * `aria-hidden` decoration of the figure after it — the mark says whether the
 * sitting is éliminatoire, which is a fact the band does not carry and cannot
 * replace.
 */
export function ScoreTag({
  score25,
  mark,
  prefix,
  variant = "tint",
  className,
}: {
  score25: number;
  /** `solid` for a pill on a surface that already wears the band (#188). */
  variant?: "tint" | "solid";
  /** `✓` / `✕` — whether the mark clears the DELF floor, where that is shown. */
  mark?: string;
  /** A phrase before the note, e.g. « Déjà passé ». */
  prefix?: string;
  className?: string;
}) {
  const band = scoreTone(score25);
  const tone = TONE_CLASSES[band];
  const colour =
    variant === "solid" ? cn(SOLID_CLASSES[band], solidInk) : cn(tone.fill, tone.ink, tone.ring);

  return (
    <span className={cn(tagShape, colour, className)}>
      {prefix && <span>{prefix} ·</span>}
      {mark && <span aria-hidden>{mark}</span>}
      <span>
        {formatScore25(score25)}/{COMPETENCY_MAX}
      </span>
    </span>
  );
}
