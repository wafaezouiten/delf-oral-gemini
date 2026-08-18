import { cn } from "@/lib/ui/class-names";

/**
 * Five bars breathing in a staggered wave — the "a mic is live" glyph, beside
 * the préparation's pre-flight mic test.
 *
 * PORT NOTE: `components/po/po-audio-bars.tsx` in the reference, which runs it
 * on motion/react. Here it is one CSS class (`.po-bar` in globals.css) with a
 * per-bar delay, which puts it under the product's `prefers-reduced-motion`
 * rule — see the note there for why that matters more than the library.
 *
 * It is decorative motion and NOT a level meter. The reference says the same
 * thing in its own header, and it is worth repeating at every call site: this
 * animates whether or not the candidate is making any sound, so reading it as
 * "the microphone can hear me" would be reading it wrong. What it means is "the
 * browser gave us the microphone and we are holding it", which is what the row's
 * words say beside it.
 */

const BAR_DELAYS = ["0s", "0.15s", "0.3s", "0.45s", "0.6s"];

export function AudioBars({
  heightClass = "h-4",
  className,
}: {
  /** Tailwind height, so the same wave reads at 16 px or 20 px. */
  heightClass?: string;
  /** A text-colour utility; the bars paint with `currentColor`. */
  className?: string;
}) {
  return (
    <span className={cn("flex items-end gap-[2.5px]", heightClass, className)} aria-hidden>
      {BAR_DELAYS.map((delay) => (
        <span
          key={delay}
          className={cn("po-bar w-[3px] rounded-full bg-current", heightClass)}
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}
