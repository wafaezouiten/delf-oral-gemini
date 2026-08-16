"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/ui/class-names";
import { HUB_LINKS } from "@/lib/ui/epreuve-hub";

/**
 * The three destinations of the épreuve area, in the masthead.
 *
 * A client component for one reason: `aria-current="page"` needs to know which
 * one is open, and that is `usePathname`. Marking the current link matters more
 * than it looks — without it the nav is three identical links to a screen reader
 * and the candidate has no way to tell where they already are.
 *
 * The active state is a fill and a word ("page" via `aria-current`), never a
 * tint alone, which is the same rule the badges are under.
 */
const LINKS = [
  { href: "/app", label: "L'épreuve" },
  { href: HUB_LINKS.sujets, label: "Sujets" },
  { href: HUB_LINKS.tableauDeBord, label: "Tableau de bord" },
] as const;

export function HubNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Production orale">
      <ul className="flex items-center gap-1">
        {LINKS.map((link) => {
          const current = pathname === link.href;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
                  current
                    ? "bg-primary-subtle text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
