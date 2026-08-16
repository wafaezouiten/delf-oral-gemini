/**
 * The fullscreen shell: the simulateur and the correction it produces.
 *
 * PORT NOTE: the reference's `app/(fullscreen)` route group. Both screens under
 * it draw their own chrome — `SimulatorTopBar` for the épreuve, a slim header of
 * its own for the report — and both are laid out as a viewport-height column
 * with their own internal scroll regions, which is what lets the passation dock
 * a control bar to the foot and the report scroll two columns independently.
 *
 * A viewport height, and that is the whole point of the group: the children
 * below size themselves against it and scroll inside their own panes. Let the
 * page grow past the fold instead and the passation's mic bar walks off the
 * bottom of the screen, which is the one control the candidate has.
 *
 * `h-dvh` rather than `h-full`, for two reasons and neither is a preference:
 *
 *  - **`h-full` does not resolve here.** A percentage height needs a definite
 *    height on every ancestor, and the chain above this is `<body class="min-h-full">`
 *    — a *minimum*, so `height` computes to `auto` and the percentage falls back
 *    to `auto` too. It looks like it works until the content is tall enough to
 *    prove it never did. Fixing it in the root layout would mean giving the hub
 *    pages a definite height as well, for a rule only these two screens want.
 *  - **`dvh` is the one that survives mobile.** The address bar collapsing
 *    changes the viewport, and a `100vh` control bar sits under it until the
 *    candidate scrolls — during the passation, where scrolling is the last thing
 *    they should be doing.
 */
export default function FullscreenLayout({
  children,
}: LayoutProps<"/app">) {
  return <div className="h-dvh min-h-0 overflow-hidden">{children}</div>;
}
