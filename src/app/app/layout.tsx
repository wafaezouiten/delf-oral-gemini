import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { requireUserId } from "@/lib/auth/exam-guard";

/**
 * The authenticated shell.
 *
 * This redirect is a courtesy, not the lock. A layout does not re-render on a
 * client-side transition and does not control whether the segment below it
 * renders — Next's own guidance ("Layouts and auth checks" in
 * `node_modules/next/dist/docs/01-app/02-guides/authentication.md`) is that the
 * check belongs next to the data. So every page under `/app` runs its own, and
 * this one only spares a signed-out visitor the flash of an empty shell.
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  await requireUserId();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      {/* The masthead of a convocation: the diploma named in full, ruled off in
          the tricolore. `no-print` because a printed correction is a grade
          sheet, not a screenshot of an application. */}
      <header className="no-print">
        <div className="bg-card border-border flex items-center justify-between border-b px-6 py-3">
          <Link href="/app" className="flex items-baseline gap-2">
            <span className="font-serif text-base font-semibold">DELF B2</span>
            <span className="text-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
              Production orale
            </span>
          </Link>
          <UserButton />
        </div>
        <div className="tricolore" aria-hidden />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
