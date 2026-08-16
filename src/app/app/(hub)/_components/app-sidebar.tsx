"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

import { ChartIcon, ClockIcon, DocumentIcon, MicIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";
import { HUB_LINKS, isNavLinkActive } from "@/lib/ui/epreuve-hub";

/**
 * The app's navigation, as a rail on desktop and a tab bar on the phone.
 *
 * PORT NOTE: the reference's `components/app-sidebar/*` — brand block at the
 * top, the destinations in the body, the account block in the footer, and a
 * separate fixed bottom tab bar below `md` (`mobile-tab-bar.tsx`). Reproduced in
 * that shape, at this product's size.
 *
 * The reference's sidebar is a shadcn `<Sidebar collapsible="icon">` with a rail
 * toggle, ⌘B, a sheet on mobile, and collapsible groups — because it navigates
 * four épreuves each with three sub-links, plus a dashboard and a billing page.
 * This product has one épreuve and three destinations. A collapse control for a
 * rail that holds three links costs a provider, a persisted cookie and a
 * keyboard shortcut to hide 208 pixels, so it is not reproduced; what is
 * reproduced is the anatomy, the active-state rules and the mobile split.
 *
 * The three states are told apart by more than a tint, as everything in this
 * product is: the current link has a filled surface, a heavier weight AND
 * `aria-current="page"`. Without the last one the rail is three identical links
 * to a screen reader, and the candidate cannot tell where they already are.
 */

const LINKS = [
  // `exact`: /app is a prefix of every route in the product, so the subtree rule
  // would light this one everywhere. See `isNavLinkActive`.
  { href: "/app", label: "L'épreuve", short: "Épreuve", Icon: MicIcon, exact: true },
  { href: HUB_LINKS.sujets, label: "Sujets", short: "Sujets", Icon: DocumentIcon, exact: false },
  {
    href: HUB_LINKS.tableauDeBord,
    label: "Tableau de bord",
    short: "Progrès",
    Icon: ChartIcon,
    exact: false,
  },
  {
    href: HUB_LINKS.historique,
    label: "Historique",
    short: "Historique",
    Icon: ClockIcon,
    exact: false,
  },
] as const;

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop rail. `no-print` for the reason the masthead always was: a
          printed correction is a grade sheet, not a screenshot of an app. */}
      <aside className="no-print bg-card border-border sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r md:flex">
        <div className="px-5 pt-5 pb-4">
          <Link href="/app" className="block">
            <span className="font-serif block text-base font-semibold">DELF B2</span>
            <span className="text-muted-foreground block text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              Production orale
            </span>
          </Link>
        </div>

        {/* The tricolore rule stays — it moved from under the masthead to under
            the brand block, which is the same job in the new furniture. */}
        <div className="tricolore mx-5" aria-hidden />

        <nav aria-label="Production orale" className="flex-1 px-3 py-4">
          <ul className="flex flex-col gap-1">
            {LINKS.map(({ href, label, Icon, exact }) => {
              const current = isNavLinkActive(pathname, href, exact);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.8125rem] transition-colors",
                      current
                        ? "bg-primary-subtle text-primary font-semibold"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted font-medium",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-border flex items-center gap-2.5 border-t px-4 py-3">
          <UserButton />
          <span className="text-muted-foreground truncate text-xs">Mon compte</span>
        </div>
      </aside>

      {/* Phone: a slim top bar for the brand and the account, because neither
          fits a five-slot tab bar and both have to stay reachable. */}
      <header className="no-print bg-card border-border sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-2.5 md:hidden">
        <Link href="/app" className="flex items-baseline gap-2">
          <span className="font-serif text-sm font-semibold">DELF B2</span>
          <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.16em] uppercase">
            Production orale
          </span>
        </Link>
        <UserButton />
      </header>
    </>
  );
}

/**
 * The phone's navigation: a fixed bottom tab bar.
 *
 * PORT NOTE: the reference's `MobileTabBar`, including the two details that are
 * easy to drop and expensive to miss — `pb-[env(safe-area-inset-bottom)]`, so
 * the tabs clear the home indicator on a notched phone rather than sitting under
 * it, and a distinct `aria-label` from the desktop rail's, since two navigation
 * landmarks sharing a name are indistinguishable to assistive tech.
 *
 * Rendered by the `(hub)` layout only. The simulateur and the correction are
 * under `(fullscreen)` and keep their own chrome — a tab bar across the foot of
 * the passation would sit exactly where the mic is.
 */
export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <div className="no-print bg-card border-border fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] md:hidden">
      <nav aria-label="Navigation mobile" className="flex h-16 items-center justify-around px-1">
        {LINKS.map(({ href, short, label, Icon, exact }) => {
          const current = isNavLinkActive(pathname, href, exact);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              aria-label={label}
              className={cn(
                "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md transition-colors",
                current ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className={cn("rounded-md px-2 py-1", current && "bg-primary-subtle")}>
                <Icon className="size-5" />
              </span>
              <span className="text-[0.6875rem] leading-tight font-semibold">{short}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
