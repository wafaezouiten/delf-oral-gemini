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
      <header className="border-border flex items-center justify-between border-b px-6 py-3">
        <Link href="/app" className="text-sm font-semibold">
          DELF B2 · Production orale
        </Link>
        <UserButton />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
