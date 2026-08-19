/**
 * This product's palette, handed to Clerk's own components.
 *
 * Clerk draws the account screens — name, e-mail, password, sessions — and it
 * should keep drawing them: they are a solved problem, they change with the
 * provider, and reimplementing them would give the product two places to change
 * an e-mail with one of them eventually wrong. What Clerk should *not* do is
 * draw them in its own blue-and-rounded default, in the middle of a product
 * whose every surface is dressed as printed matter.
 *
 * So the layout stays Clerk's and the palette becomes ours. Two things do most
 * of the work: `borderRadius: 2px`, which is the `.sheet` number and the single
 * difference between "an app card" and "a sheet of paper", and the navy that
 * every primary control in this product already uses.
 *
 * **The literals are duplicated from `globals.css` on purpose, and they have to
 * be kept in step by hand.** Clerk derives a whole scale from each colour it is
 * given — hovers, borders, disabled states — so it needs a value it can parse,
 * and `var(--primary)` is not one: it would reach the scale generator as an
 * opaque string and come back as a set of shades of nothing. Reading the
 * computed styles at runtime would work and would cost a mounted effect and a
 * flash of the default theme on every account screen, which is a worse trade for
 * six colours that have not changed since #11.
 *
 * The fonts are the exception and can stay as `var(…)`: they are passed through
 * as a CSS value rather than parsed, and `next/font` owns the family names.
 */

import type { ComponentProps } from "react";
import type { UserProfile } from "@clerk/nextjs";

/** The tokens, from `src/app/globals.css`. Keep in step with it. */
const PALETTE = {
  primary: "#1b3a7a",
  primaryForeground: "#ffffff",
  foreground: "#16181d",
  background: "#ffffff",
  muted: "#ecedea",
  mutedForeground: "#5b6069",
  border: "#dcdcd6",
  danger: "#a4132a",
  success: "#1c6b3f",
  warning: "#8a5200",
} as const;

export const clerkAppearance: NonNullable<ComponentProps<typeof UserProfile>["appearance"]> = {
  variables: {
    colorPrimary: PALETTE.primary,
    colorPrimaryForeground: PALETTE.primaryForeground,
    colorForeground: PALETTE.foreground,
    colorBackground: PALETTE.background,
    colorMuted: PALETTE.muted,
    colorMutedForeground: PALETTE.mutedForeground,
    colorBorder: PALETTE.border,
    colorInput: PALETTE.background,
    colorInputForeground: PALETTE.foreground,
    colorDanger: PALETTE.danger,
    colorSuccess: PALETTE.success,
    colorWarning: PALETTE.warning,
    // The focus ring is `--primary` everywhere else in the product
    // (`globals.css`, `:focus-visible`), and a second ring colour inside one
    // card would read as a different application.
    colorRing: PALETTE.primary,
    // `.sheet`. The one number that decides whether this reads as stationery.
    borderRadius: "2px",
    fontFamily: "var(--font-inter), system-ui, sans-serif",
  },
  /**
   * Layout, not palette — the only three overrides in the product, and each one
   * exists so Clerk's card can be *part of* a sheet this product draws rather
   * than a second container sitting inside the first.
   *
   *  - `rootBox` / `cardBox` take the width they are given, so the card fills
   *    the page's column instead of sizing itself and sitting off-centre in it.
   *  - the border and the shadow come off, because the page has already drawn
   *    them: two nested frames one pixel apart is the tell that something has
   *    been embedded rather than built in, and « Réinitialiser ma progression »
   *    sits inside the same frame at the bottom.
   *
   * The trailing `!` is Tailwind v4's important modifier, and it is not
   * decoration: Clerk ships its own baseline for these two properties, and a
   * plain utility loses to it depending on which stylesheet lands last.
   *
   * Anything beyond this is redrawing Clerk's card by hand, which is the thing
   * embedding it was meant to avoid.
   */
  elements: {
    rootBox: "w-full",
    cardBox: "w-full border-0! shadow-none!",
    card: "border-0! shadow-none!",
  },
};
