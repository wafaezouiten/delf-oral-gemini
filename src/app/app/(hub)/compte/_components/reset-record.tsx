"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { dangerButton } from "@/app/_components/button-styles";
import { requestRecordReset } from "@/lib/account/reset";

/**
 * « Réinitialiser » — the control, and what it says after (#69, #175).
 *
 * It sits in the page header, opposite the title, rather than anywhere in the
 * account card below it. Two reasons, and the second is the one that decided it:
 * it is not an account setting — it touches nothing Clerk owns — and Clerk's
 * card is tall enough that a control under it opens below the fold, where nobody
 * scrolls to find it.
 *
 * **One click, on the candidate's instruction (#175).** It used to open a
 * « Réinitialiser ma progression ? » panel with Annuler and Confirmer, and the
 * argument for that panel was that a paragraph of consequences is read when it
 * has to be rather than skimmed past when it is always there. It is gone: the
 * button now sends the reset itself. What the panel said, the header line under
 * the button says before the click, so nothing about the action is unannounced —
 * and this reset is the rare destructive-looking control that destroys nothing.
 * The épreuves go to the archive of the historique with their corrections and
 * their recordings, and `/app/results/:id` keeps opening on every one of them,
 * so a candidate who did not mean it loses a tableau de bord, not a record.
 *
 * **Red, and now the only red in the flow.** The old rule spent the colour on
 * the trigger and deliberately left the confirm plain, so that red meant "read
 * the panel" rather than "click through me". With no panel left to read, the red
 * goes back to being what it looks like: notice, on the one control here that
 * changes the record.
 *
 * The double press is the button's own `disabled`, not a guard of ours: React
 * flushes a click's state before the next click is delivered, so the second
 * press of a double-click lands on a button that is already out. And a press
 * that got through anyway would archive nothing — the route is idempotent, and
 * `archived: 0` is a success rather than an error.
 *
 * No count is promised beforehand: a number would mean handing this client
 * component the candidate's record every time the account page mounts. The route
 * reports what it archived, so the number is said *after*, where it is a fact
 * rather than a promise.
 *
 * **What it says after goes in the line that was already there, and never in a
 * block of its own.** A notice added under the button grows the header cell,
 * and the header is above Clerk's card: a candidate who presses the button
 * watches their profile jump down the page to make room for a sentence. So the
 * slot under the button carries whichever of the three is true — what the
 * button does, what went wrong, or what it archived — and the header keeps its
 * height whichever it is. It also means the failure is no longer a bordered
 * panel; it is the same line in `text-danger`, which is enough on a screen with
 * one control.
 */
export function ResetRecord() {
  const router = useRouter();

  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [archived, setArchived] = useState<number | null>(null);

  async function reset() {
    setPending(true);
    setFailed(null);
    // The previous count goes with the click rather than with its answer: a
    // second reset that fails must not leave « 4 épreuves sont passées aux
    // archives » standing over an error about the reset that just did not.
    setArchived(null);

    const outcome = await requestRecordReset();

    setPending(false);
    if (!outcome.reset) {
      setFailed(
        outcome.reason === "unreachable"
          ? "Votre connexion n'a pas permis d'enregistrer la réinitialisation. Réessayez."
          : outcome.status === 401
            ? "Votre session a expiré. Reconnectez-vous, puis réessayez."
            : "La réinitialisation n'a pas pu être enregistrée. Réessayez dans un instant.",
      );
      return;
    }

    setArchived(outcome.archived);
    // The tableau de bord, the sujet cards and the historique are all rendered
    // from the record that just changed. Without this they would go on printing
    // the numbers they were built with until the next full navigation.
    router.refresh();
  }

  return (
    // Only as wide as its label, at every width since #185. It used to stretch
    // to the full width of a phone, which made the one red control on this page
    // the biggest thing on it — read as the page's main action, directly under
    // the title, on the screen where a mis-tap is easiest. It is the header's
    // second element, not a form control. From `sm` up nothing changed: it
    // shrinks to its contents and is pushed to the far right by `ml-auto`,
    // independently of what the title beside it is doing, and `items-end` takes
    // it to the container's last pixel rather than leaving it inside a block
    // that ends there.
    <div className="flex w-full flex-col items-start sm:ml-auto sm:w-auto sm:shrink-0 sm:items-end">
      {/* `items-start` on the phone as well as `items-end` from `sm`: a
          flex column stretches its children by default, so the button would
          have gone back to full width by the box that holds it rather than by
          a class on it. */}
      <div className="flex w-full flex-col items-start gap-2 sm:w-auto sm:items-end">
        <button type="button" onClick={reset} disabled={pending} className={dangerButton}>
          {pending ? "Réinitialisation…" : failed ? "Réessayer" : "Réinitialiser"}
        </button>
        {/* One slot under the button, three things it can say: what the button
            does, what went wrong, what it archived. Capped, so the line wraps
            into a short block instead of stretching the header cell and
            dragging the button back in from the edge. */}
        {failed ? (
          <p role="alert" className="text-danger max-w-56 text-xs leading-relaxed sm:text-right">
            {failed}
          </p>
        ) : archived !== null ? (
          <p
            role="status"
            className="text-muted-foreground max-w-56 text-xs leading-relaxed sm:text-right"
          >
            {archived === 0
              ? "Il n'y avait aucune épreuve à archiver."
              : `${archived} épreuve${archived > 1 ? "s" : ""} ${archived > 1 ? "sont passées" : "est passée"} aux archives. Vous ${archived > 1 ? "les" : "la"} retrouvez dans l'historique.`}
          </p>
        ) : (
          // The whole warning now — and it already says *archive* rather than
          // *supprime*, which is the one thing a candidate has to know before
          // pressing.
          <p className="text-muted-foreground max-w-56 text-xs leading-relaxed sm:text-right">
            Archive vos épreuves passées et remet vos tableaux de bord à zéro.
          </p>
        )}
      </div>
    </div>
  );
}
