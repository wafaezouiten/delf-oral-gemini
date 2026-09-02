"use client";

import { CloseIcon, PencilIcon } from "@/app/_components/po/icons";
import { cn } from "@/lib/ui/class-names";

/**
 * The préparation notes, on call during the passation: a slide-over the
 * candidate can pull open to glance at the plan they wrote, the way the paper
 * notes stay on the desk in the real épreuve. Read-only here — the writing
 * happened in préparation.
 *
 * PORT NOTE: `components/po/po-notes-drawer.tsx`. The reference animates it in
 * and out with `AnimatePresence`; this uses a CSS transform transition and stays
 * mounted, which is the same slide and also keeps the panel in the DOM so a
 * screen reader that was reading it does not lose its place mid-sentence when it
 * closes. `inert` is what makes the hidden panel unreachable by tab — without it
 * a closed drawer is a focus trap sitting off the right edge of the screen.
 */
export function NotesDrawer({
  open,
  notes,
  onClose,
}: {
  open: boolean;
  notes: string;
  onClose: () => void;
}) {
  return (
    <aside
      inert={!open}
      aria-label="Mes notes de préparation"
      className={cn(
        "border-border bg-card absolute top-0 right-0 bottom-0 z-40 flex w-[min(23.75rem,92vw)] flex-col border-l shadow-[-1.25rem_0_3rem_-1.75rem_rgba(13,27,61,0.35)] transition-transform duration-300 ease-out",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-3.5 py-2.5">
        <PencilIcon className="text-muted-foreground size-3.5" />
        <h2 className="text-[0.78125rem] font-bold">Mes notes de préparation</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer les notes"
          className="border-border bg-card text-muted-foreground hover:bg-muted ml-auto flex size-7 items-center justify-center rounded-full border transition-colors"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <p className="text-foreground/85 text-[0.84375rem] leading-[1.75] whitespace-pre-wrap">
          {notes}
        </p>
      </div>
    </aside>
  );
}
