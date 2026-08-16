"use client";

import { useEffect, useRef } from "react";

import { dangerButton, secondaryButton } from "@/app/_components/button-styles";
import { AlertIcon } from "@/app/_components/po/icons";

/**
 * "Nothing was heard" — the confirmation before a silent monologue becomes a
 * débat.
 *
 * A **confirmation and not a refusal**, which is the whole design of #39. The
 * signal underneath is a crude amplitude measure (`lib/audio/voice-activity`)
 * and a quiet speaker on a low-gain microphone can defeat it, so the cost of
 * being wrong has to stay at one extra dialog. A hard block would risk stranding
 * a candidate who could then reach neither the débat nor the end of the épreuve
 * — worse than the accident it prevents.
 *
 * So the candidate is told what was measured, not what they did. "Nous n'avons
 * rien entendu" is checkable and survives being wrong; "vous n'avez rien dit"
 * is an accusation, and it is the microphone's word against theirs.
 *
 * `Continuer le monologue` is the autofocused, plain button: the candidate has
 * clock left, and going back to speak is almost always what they want when this
 * appears for a real reason.
 */
export function SilentMonologueDialog({
  open,
  onKeepSpeaking,
  onContinueAnyway,
}: {
  open: boolean;
  onKeepSpeaking: () => void;
  /** Move to the débat regardless. Always available. */
  onContinueAnyway: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        // Escape means "let me carry on speaking", which is the safe reading.
        event.preventDefault();
        onKeepSpeaking();
      }}
      aria-labelledby="silent-monologue-title"
      className="bg-card text-foreground border-border m-auto w-[min(30rem,92vw)] border p-0 backdrop:bg-black/50"
    >
      <div className="space-y-4 p-6">
        <h2 id="silent-monologue-title" className="font-serif text-lg font-semibold">
          Nous n&apos;avons rien entendu
        </h2>

        <div className="border-warning/40 bg-warning-subtle text-warning flex items-start gap-2.5 border p-3.5">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm leading-relaxed">
            Votre microphone fonctionne, mais il n&apos;a presque rien capté
            pendant votre monologue.
          </p>
        </div>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Le monologue suivi est noté : en passant au débat maintenant, cette
          partie sera corrigée comme une non-réponse. Vous avez encore du temps
          pour la présenter.
        </p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onKeepSpeaking}
            className={secondaryButton}
            autoFocus
          >
            Continuer le monologue
          </button>
          <button type="button" onClick={onContinueAnyway} className={dangerButton}>
            Passer au débat quand même
          </button>
        </div>
      </div>
    </dialog>
  );
}
