import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";

/**
 * The authenticated shell.
 *
 * `proxy.ts` already blocks unauthenticated requests to /app; this redirect is
 * the second lock. Route protection is the one place where being paranoid costs
 * nothing.
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

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
