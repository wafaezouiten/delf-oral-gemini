import {
  BAND_LABELS,
  BAND_TONE,
  GRILLE_BANDS,
  type BandTone,
  type GrilleBand,
} from "@/lib/delf/grille";

/**
 * One criterion's band, drawn on the grille's own scale.
 *
 * The official corrector grid does not print a number in a box: it prints the
 * four levels side by side and rings the one awarded, so a candidate can see at
 * a glance not just what they scored but what the next band up would have been.
 * This is that, and the reason the whole 0 · 1 · 3 · 5 row is rendered rather
 * than the single number the model returned.
 *
 * Two rules hold this together, and both come from #11:
 *
 *  - **The colour and the label come from `grille.ts`.** `BAND_TONE` is the
 *    source of the tone and `BAND_LABELS` of the words; the only thing this file
 *    owns is which CSS token a tone maps to. `TONE_CLASSES` is keyed by
 *    `BandTone`, so a tone added to the grille fails the build here instead of
 *    quietly rendering grey.
 *  - **The colour is never the message.** The awarded cell is filled *and* ruled
 *    *and* carries the only bold numeral in the row; the band's name is written
 *    out beside it. Read in greyscale, with the tint gone, the row still says
 *    which band was awarded.
 */
const TONE_CLASSES: Record<BandTone, { fill: string; text: string; ring: string }> = {
  red: { fill: "bg-band-red-subtle", text: "text-band-red", ring: "border-band-red" },
  amber: { fill: "bg-band-amber-subtle", text: "text-band-amber", ring: "border-band-amber" },
  green: { fill: "bg-band-green-subtle", text: "text-band-green", ring: "border-band-green" },
  emerald: {
    fill: "bg-band-emerald-subtle",
    text: "text-band-emerald",
    ring: "border-band-emerald",
  },
};

export function BandScale({ band }: { band: GrilleBand }) {
  const tone = TONE_CLASSES[BAND_TONE[band]];

  // `relative`, and it is load-bearing (#114): `sr-only` is `position:
  // absolute`, and without a positioned ancestor the hidden span anchors to
  // the *document* — it escapes the rail's scroll container, parks itself
  // past the page's end, and grows the page by the distance the rail was
  // scrolled. A one-pixel invisible span was the whole dead band.
  return (
    <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {/* One statement for a screen reader, rather than four cells it would have
          to reassemble into one. The cells below are decoration of this text. */}
      <span className="sr-only">
        Note {band} sur 5 : {BAND_LABELS[band]}. Échelle de la grille : {GRILLE_BANDS.join(", ")}.
      </span>

      <div className="flex" aria-hidden>
        {GRILLE_BANDS.map((value, index) => {
          const awarded = value === band;
          return (
            <span
              key={value}
              className={[
                "tabular flex size-7 items-center justify-center border text-xs",
                index === 0 ? "rounded-l-md" : "",
                index === GRILLE_BANDS.length - 1 ? "rounded-r-md" : "",
                index > 0 ? "-ml-px" : "",
                awarded
                  ? `relative z-10 border-2 font-bold ${tone.fill} ${tone.text} ${tone.ring}`
                  : "border-border text-muted-foreground/60",
              ].join(" ")}
            >
              {value}
            </span>
          );
        })}
      </div>

      <span className={`text-xs font-semibold ${tone.text}`} aria-hidden>
        {BAND_LABELS[band]}
      </span>
    </div>
  );
}
