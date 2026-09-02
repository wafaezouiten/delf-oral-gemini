"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";

import { ChartIcon, ClockIcon, DocumentIcon, MicIcon, UserIcon } from "@/app/_components/po/icons";
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
    // One destination, one name (#183). The tab bar abbreviated this to
    // « Progrès », so the phone and the rail called the same screen two
    // different things and neither was the name printed at the top of the page
    // it opens. It wraps to two lines in a 75 px tab, which is what the tab bar
    // and the page agreeing costs.
    short: "Tableau de bord",
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

/**
 * The candidate's avatar, at whatever size the surface it sits on draws icons.
 *
 * Clerk's photo when there is one, this product's own glyph when there is not —
 * and the glyph is also what renders before `useUser` has resolved, so the slot
 * never collapses and the label beside it never reflows.
 *
 * `unoptimized`: the src is Clerk's own host, and routing it through the image
 * optimiser would mean naming a remote pattern in `next.config.ts` for one
 * 20 px avatar. Served as-is, no host needs listing.
 */
function Avatar({ px }: { px: number }) {
  const { user } = useUser();

  if (!user?.imageUrl) {
    return (
      <span
        aria-hidden
        className="border-border bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-full border"
        style={{ width: px, height: px }}
      >
        {/* `className` explicitly, and not for the `shrink-0`: `Icon` defaults
            it to `size-4`, and a 16 px class sitting under a 12 px inline
            style reads as the size the glyph is. Passing one replaces the
            default, so the style is the only thing sizing this. */}
        <UserIcon
          className="shrink-0"
          style={{ width: Math.round(px * 0.6), height: Math.round(px * 0.6) }}
        />
      </span>
    );
  }

  return (
    <Image
      src={user.imageUrl}
      alt=""
      width={px}
      height={px}
      unoptimized
      className="border-border shrink-0 rounded-full border object-cover"
      style={{ width: px, height: px }}
    />
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const compteCurrent = isNavLinkActive(pathname, HUB_LINKS.compte);

  return (
    <>
      {/* Desktop rail. `no-print` for the reason the masthead always was: a
          printed correction is a grade sheet, not a screenshot of an app. */}
      <aside className="no-print bg-card border-border sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r md:flex">
        <div className="px-5 pt-5 pb-4">
          <Link href="/app" className="block">
            <span className="block font-serif text-base font-semibold">DELF B2</span>
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

        {/* Mon compte, at the foot of the rail — a destination like the four
            above rather than a menu (#183).
         *
         * Clerk's `<UserButton>` stood here and opened a popover offering
         * « Gérer le compte » and « Se déconnecter ». The first of those two was
         * already this href, so the popover's whole job was to put one click in
         * front of the page; the sign out it also carried now sits on that page,
         * with the rest of the account. The avatar goes where it says it goes.
         *
         * It wears the rail's own active treatment, `aria-current` included,
         * because it is now in the same list — a screen reader is told the
         * candidate is on their account rather than merely near it. */}
        <div className="border-border border-t p-3">
          <Link
            href={HUB_LINKS.compte}
            aria-current={compteCurrent ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.8125rem] transition-colors",
              compteCurrent
                ? "bg-primary-subtle text-primary font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-muted font-medium",
            )}
          >
            <Avatar px={20} />
            <span className="truncate">Mon compte</span>
          </Link>
        </div>
      </aside>

      {/* Phone: a slim top bar for the brand alone. The avatar left it for the
          tab bar (#183) — the navigation on a phone is at the foot of the
          screen, and the account was the one destination reachable only from
          the opposite end of it. */}
      <header className="no-print bg-card border-border sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-2.5 md:hidden">
        <Link href="/app" className="flex items-baseline gap-2">
          <span className="font-serif text-sm font-semibold">DELF B2</span>
          <span className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.16em] uppercase">
            Production orale
          </span>
        </Link>
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
 * Five tabs since #183: the four destinations, and the account the avatar used
 * to reach from the top bar. The labels are 10 px and wrap rather than being
 * abbreviated — « Tableau de bord » over two lines is the page's own name,
 * which « Progrès » over one was not.
 *
 * Rendered by the `(hub)` layout only. The simulateur and the correction are
 * under `(fullscreen)` and keep their own chrome — a tab bar across the foot of
 * the passation would sit exactly where the mic is.
 */
export function MobileTabBar() {
  const pathname = usePathname();
  const compteCurrent = isNavLinkActive(pathname, HUB_LINKS.compte);

  return (
    <div className="no-print bg-card border-border fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] md:hidden">
      <nav aria-label="Navigation mobile" className="flex h-16 items-stretch justify-around px-0.5">
        {LINKS.map(({ href, short, label, Icon, exact }) => {
          const current = isNavLinkActive(pathname, href, exact);
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? "page" : undefined}
              aria-label={label}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-0.5 transition-colors",
                current ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span className={cn("rounded-md px-2 py-0.5", current && "bg-primary-subtle")}>
                <Icon className="size-5" />
              </span>
              <span className="text-center text-[0.625rem] leading-[1.15] font-semibold text-balance">
                {short}
              </span>
            </Link>
          );
        })}

        {/* The account, as the fifth tab. The avatar is the icon — it is what a
            candidate looks for — and « Compte » is the word under it, so the tab
            is readable before the photo has loaded and to someone who never set
            one. */}
        <Link
          href={HUB_LINKS.compte}
          aria-current={compteCurrent ? "page" : undefined}
          aria-label="Mon compte"
          className={cn(
            "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-0.5 transition-colors",
            compteCurrent ? "text-primary" : "text-muted-foreground",
          )}
        >
          <span className={cn("rounded-md px-2 py-0.5", compteCurrent && "bg-primary-subtle")}>
            <Avatar px={20} />
          </span>
          <span className="text-center text-[0.625rem] leading-[1.15] font-semibold">Compte</span>
        </Link>
      </nav>
    </div>
  );
}
