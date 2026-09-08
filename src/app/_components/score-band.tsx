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
 * The band worn by the verdict's pill (#190): the subtle fill, the ink and the
 * ring, for a pill that carries a band's *name* beside the mark rather than the
 * mark itself. `ScoreTag` prints the figure; this dresses the word.
 */
export function scorePill(tone: ScoreTone): string {
  const { fill, ink, ring } = TONE_CLASSES[tone];
  return cn(fill, ink, ring);
}

/**
 * The band worn by a whole surface rather than a pill — the sujet cards (#188),
 * which take their last score's wash and ring so a grid of them reads at a
 * glance. The recipe is the main project's (delf-preps, `TONE_CARD`): the
 * subtle fill over the whole card, the band's hue as the hairline, deepening on
 * hover where a neutral card's hairline goes navy. The wash is the subtle token
 * at 70 % rather than full — a shade lighter than the pill's own fill, by the
 * user's call, so the card reads as tinted paper rather than as a coloured
 * block. The ink is deliberately not part of it: the card's text stays on the
 * foreground and the muted tokens, which hold AA on every one of the five
 * subtle fills at full strength (see the `--score-*` block in `globals.css`)
 * and therefore on the lighter wash too.
 *
 * Literal class strings per tone rather than `${fill}/70`: Tailwind only
 * generates what it can read in the source.
 */
const SURFACE_CLASSES: Record<ScoreTone, string> = {
  red: "bg-score-red-subtle/70 border-score-red/40 hover:border-score-red/70",
  coral: "bg-score-coral-subtle/70 border-score-coral/40 hover:border-score-coral/70",
  orange: "bg-score-orange-subtle/70 border-score-orange/40 hover:border-score-orange/70",
  yellow: "bg-score-yellow-subtle/70 border-score-yellow/40 hover:border-score-yellow/70",
  green: "bg-score-green-subtle/70 border-score-green/40 hover:border-score-green/70",
};

export function scoreSurface(score25: number): string {
  return SURFACE_CLASSES[scoreTone(score25)];
}

/**
 * The pill on a chip: the band's ink and ring on `bg-card`, for a pill that
 * sits on a surface already wearing the band's wash (`scoreSurface`), where the
 * tinted pill would sink into its own colour. The main project's rule for the
 * same pill on the same card: keep the ink, swap the one fill that no longer
 * separates it from the surface.
 */
const chipFill = "bg-card";

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
  /** `chip` for a pill on a surface that already wears the band (#188). */
  variant?: "tint" | "chip";
  /** `✓` / `✕` — whether the mark clears the DELF floor, where that is shown. */
  mark?: string;
  /** A phrase before the note, e.g. « Déjà passé ». */
  prefix?: string;
  className?: string;
}) {
  const band = scoreTone(score25);
  const tone = TONE_CLASSES[band];
  const colour = cn(variant === "chip" ? chipFill : tone.fill, tone.ink, tone.ring);

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
