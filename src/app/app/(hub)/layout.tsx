import { AppSidebar, MobileTabBar } from "./_components/app-sidebar";

/**
 * The chrome the three reading screens share: the hub, the sujets and the
 * tableau de bord.
 *
 * PORT NOTE: the reference puts its app navigation in a **sidebar**
 * (`components/app-sidebar/*`) rather than a top bar, with a fixed bottom tab
 * bar below `md`. This reproduces that split. It replaces the masthead this
 * project carried before, and the tricolore rule moved with it — from under the
 * masthead to under the sidebar's brand block, which is the same job in the new
 * furniture.
 *
 * A row on desktop, a column on the phone, and the page's own scroll rather than
 * a pane's: these three screens are documents to read, so the rail is `sticky`
 * beside a normally-scrolling page instead of the `(fullscreen)` group's
 * viewport-locked panes. The simulateur needs those; a catalogue does not, and
 * an inner scroll container here would cost the page its scroll restoration.
 *
 * `pb-20` on the content, below `md` only: the tab bar is `fixed`, so it is out
 * of flow and would otherwise cover the last rows of the sujets grid and the
 * dashboard's last épreuve.
 */
export default function HubLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">{children}</div>
      <MobileTabBar />
    </div>
  );
}
