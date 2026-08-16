import type { ReactNode } from "react";

import { cn } from "@/lib/ui/class-names";

/**
 * The small pill the hub, the kiosk and the report all print facts in.
 *
 * PORT NOTE: this stands in for the reference's `<Badge>` and `<Tag>`, two
 * shadcn components it uses interchangeably — `hub-format.tsx` carries a comment
 * about exactly that drift ("each with its own size, and the drift was immediate
 * and visible"). Since both are being reproduced by one thing, they are one
 * thing here.
 *
 * Three tones, and the reference's rule about them is worth keeping verbatim
 * because it is the reason the hub reads calmly: **neutral by default, colour
 * for the exception.** A pill that every card carries — the épreuve's shape, the
 * partie number, what a sujet asks you to produce — classifies nothing by being
 * coloured, so it is neutral. A pill only some cards carry, like a score already
 * earned, is the one allowed an accent.
 *
 * `success` and `danger` never appear without a word or a mark inside them, per
 * the product's rule that colour carries no meaning alone. That is not enforced
 * here — it is enforced by every caller passing prose.
 */

type TagTone = "neutral" | "success" | "danger";

const TONES: Record<TagTone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  success: "border-success/30 bg-success-subtle text-success",
  danger: "border-danger/40 bg-danger-subtle text-danger",
};

export function Tag({
  tone = "neutral",
  className,
  children,
}: {
  tone?: TagTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "tabular inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.6875rem] font-semibold",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The label voice of the hub and the report: uppercase, tracked out, muted.
 *
 * PORT NOTE: `components/epreuve-hub/hub-kicker.tsx`, and the reference's own
 * reason for making it a component rather than a class string is the one that
 * applies here — the several places that need one cannot drift apart, and
 * nobody is tempted to reach for a monospace face. This project already prints
 * this recipe in a dozen places as a literal; the pages this branch adds use the
 * component, and the older screens are left alone rather than churned.
 */
export function Kicker({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}
