import { requireUserId } from "@/lib/auth/exam-guard";

/**
 * The authenticated shell — the auth courtesy, and nothing else.
 *
 * This redirect is a courtesy, not the lock. A layout does not re-render on a
 * client-side transition and does not control whether the segment below it
 * renders — Next's own guidance ("Layouts and auth checks" in
 * `node_modules/next/dist/docs/01-app/02-guides/authentication.md`) is that the
 * check belongs next to the data. So every page under `/app` runs its own, and
 * this one only spares a signed-out visitor the flash of an empty shell.
 *
 * The masthead used to live here and now lives one level down, in `(hub)`. The
 * reason is the reference's route-group split: its simulateur sits under a
 * `(fullscreen)` group with no app chrome at all, because the simulateur draws
 * its own — `SimulatorTopBar` IS the chrome, and a second header above it would
 * be two navigations stacked over an épreuve that needs the whole viewport. The
 * two groups below reproduce that. Neither changes a URL.
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  await requireUserId();

  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
