import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { HubNav } from "./_components/hub-nav";

/**
 * The chrome the three reading screens share: the hub, the sujets and the
 * tableau de bord.
 *
 * PORT NOTE: the reference carries its épreuve navigation in a global app
 * header, and its hub's primary CTA with it — `hub.tsx`'s own note records that
 * the CTA was moved out of the page body and into the header precisely so it is
 * "reachable from every scroll position". That is the pattern reproduced here:
 * the three links plus the way into an épreuve live in the masthead, not in a
 * block halfway down the hub.
 *
 * The masthead itself is unchanged from what this project already had — the
 * diploma named in full, ruled off in the tricolore, `no-print` because a
 * printed correction is a grade sheet and not a screenshot of an application.
 * Only the navigation is new, and it is new because until this branch there was
 * one screen to navigate to.
 */
export default function HubLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="no-print">
        <div className="bg-card border-border flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-6 py-3">
          <Link href="/app" className="flex items-baseline gap-2">
            <span className="font-serif text-base font-semibold">DELF B2</span>
            <span className="text-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
              Production orale
            </span>
          </Link>

          <div className="flex items-center gap-3">
            <HubNav />
            <UserButton />
          </div>
        </div>
        <div className="tricolore" aria-hidden />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
