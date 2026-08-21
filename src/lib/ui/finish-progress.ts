/**
 * What « Épreuve terminée » should say while the correction is under way.
 *
 * The wait is a chain of very different segments (#86) — compressing in the
 * tab, the upload leaving it, the corrector reading — and one spinner over all
 * of them told the candidate nothing about whether anything was still moving.
 * The client can genuinely distinguish three of those states, so the screen
 * says which one it is in; the segments the client cannot see (the Files API,
 * the model) are honestly folded into the last sentence rather than invented.
 *
 * Kept pure and out of the component for the same reason `finish-failure.ts`
 * is: the mapping from state to sentence is the part with edges — a retry
 * resets the fraction to null, a browser can decline to measure the upload —
 * and `node --test` should be able to hold every sentence to its state.
 */

export type FinishStage =
  { kind: "compressing" } | { kind: "uploading"; fraction: number | null } | { kind: "correcting" };

/**
 * Which stage the screen is in, from the two facts the client holds: whether
 * the request has been built and sent (`submitting`), and how much of its body
 * has left the tab. The fraction reaches exactly 1 only from the transport's
 * own « the body has been sent » event (`finish-request.ts`), so « en cours de
 * correction » is never claimed while bytes are still leaving.
 */
export function finishStage(submitting: boolean, uploadFraction: number | null): FinishStage {
  if (!submitting) return { kind: "compressing" };
  if (uploadFraction !== null && uploadFraction >= 1) return { kind: "correcting" };
  return { kind: "uploading", fraction: uploadFraction };
}

/**
 * The sentence for the live region. Deliberately without the percentage: the
 * paragraph announces to screen readers on every change, and a figure that
 * moves several times a second would turn a status into a metronome. The
 * figure is drawn beside it, silently — see {@link uploadPercent}.
 */
export function finishStageMessage(stage: FinishStage): string {
  switch (stage.kind) {
    case "compressing":
      // Not idle: the recordings are being compressed before the request is
      // built, which takes a few seconds for a full sitting.
      return "Préparation de votre enregistrement…";
    case "uploading":
      // The recording exists only in this tab until this sentence stops being
      // true, which is why it carries the warning rather than deferring it.
      return "Envoi de votre enregistrement… Ne fermez pas cet onglet.";
    case "correcting":
      return "L'examinateur analyse votre passation selon la grille officielle du DELF B2. Cela peut prendre une minute ; ne fermez pas cet onglet.";
  }
}

/** The whole percentages the progress bar shows, or null while there is no
 *  honest figure — before the first event, and on a browser that would not
 *  measure the upload. The bounds are the transport's (`UploadProgress`:
 *  quantized whole percents, 0 to 0.99, then exactly 1), not re-clamped here —
 *  one module owns the invariant. */
export function uploadPercent(stage: FinishStage): number | null {
  if (stage.kind !== "uploading" || stage.fraction === null) return null;
  return Math.round(stage.fraction * 100);
}
