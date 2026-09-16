import type { FinishFailure } from "./finish-failure";

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
  | { kind: "compressing" }
  | { kind: "uploading"; fraction: number | null }
  | { kind: "correcting" }
  /** The finish answered 202 (#86): the sitting is safe on the server and the
   *  correction is being attached behind it. The one stage in which closing
   *  the tab costs nothing, and the sentence says so. */
  | { kind: "awaiting" };

/**
 * Which stage the screen is in, from the three facts the client holds: whether
 * the request has been built and sent (`submitting`), how much of its body has
 * left the tab, and whether the server has ACCEPTED the sitting and moved the
 * correction behind its response (#86). The fraction reaches exactly 1 only
 * from the transport's own « the body has been sent » event
 * (`finish-request.ts`), so « en cours de correction » is never claimed while
 * bytes are still leaving — and `awaiting` outranks everything, because the
 * 202 is the server's own word that the bytes arrived.
 */
export function finishStage(
  submitting: boolean,
  uploadFraction: number | null,
  accepted = false,
): FinishStage {
  if (accepted) return { kind: "awaiting" };
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
    case "awaiting":
      // The one stage that RELEASES the candidate (#86): the server has the
      // recording, so the warning the two sentences above carry would now be
      // false — and saying they may leave is the entire point of the 202.
      return "Votre prestation est bien reçue. L'examinateur l'analyse selon la grille officielle du DELF B2 — cela peut prendre une minute. Vous pouvez fermer cet onglet : votre résultat vous attendra dans votre historique.";
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

/**
 * What « Épreuve terminée » says, decided here (#234): the heading and the
 * sentence under it in each of the four states, the bar, whether the way out
 * is offered while the correction is awaited, the sentence about a recording
 * that could not be sent, and the failure notice with its two buttons. Every
 * failure field has a fallback, because `FinishFailure` carries overrides
 * only where a case needs its own words (#86).
 */
export interface FinishedView {
  failed: boolean;
  heading: string;
  lede: string;
  /** The sentence announces itself while it is progress; once the failure
   *  notice below mounts assertively, it stops, so a screen reader is not
   *  given two overlapping statements about one event. */
  live: boolean;
  percent: number | null;
  /** Leaving while the server corrects (#86): the poll is cancelled, the
   *  correction finishes either way, and the historique has it. */
  canLeaveWhileWaiting: boolean;
  /** Which recording could not be sent, in a sentence — or none. */
  dropped: string | null;
  failure: { title: string; message: string; retryable: boolean; leaveLabel: string } | null;
}

const PHASE_LABEL_FR: Record<"monologue" | "debate", string> = {
  monologue: "monologue",
  debate: "débat",
};

function droppedSentence(phases: ReadonlyArray<"monologue" | "debate">): string | null {
  if (phases.length === 0) return null;
  const which =
    phases.length === 2
      ? "Vos deux prises de parole étaient trop volumineuses pour être envoyées."
      : `Votre ${PHASE_LABEL_FR[phases[0]]} était trop volumineux pour être envoyé.`;
  return (
    `${which} Cette partie sera corrigée à partir de sa transcription seule, sans écoute de ` +
    "votre prononciation, et comptera comme une durée de zéro seconde dans la pénalité de durée."
  );
}

export function finishedView(
  stage: FinishStage,
  failure: FinishFailure | null,
  droppedPhases: ReadonlyArray<"monologue" | "debate">,
): FinishedView {
  const dropped = droppedSentence(droppedPhases);
  if (!failure) {
    return {
      failed: false,
      heading: "Épreuve terminée",
      lede: finishStageMessage(stage),
      live: true,
      percent: uploadPercent(stage),
      canLeaveWhileWaiting: stage.kind === "awaiting",
      dropped,
      failure: null,
    };
  }
  return {
    failed: true,
    heading: failure.heading ?? "Correction interrompue",
    lede:
      failure.lede ??
      (failure.retryable
        ? "Votre prestation attend d'être envoyée."
        : "Votre prestation a bien été enregistrée, mais elle n'a pas pu être corrigée."),
    live: false,
    percent: uploadPercent(stage),
    canLeaveWhileWaiting: false,
    dropped,
    failure: {
      title:
        failure.title ??
        (failure.retryable ? "L'envoi a échoué" : "Cette épreuve ne peut pas être corrigée"),
      message: failure.message,
      // A 413 or a 422 would send the same bytes to the same refusal, and the
      // candidate would sit through it twice: no retry where none can help.
      retryable: failure.retryable,
      // « Abandonner » names what leaving costs — the épreuve. The timeout's
      // override drops the word, because its sitting is accepted and may yet
      // correct itself (#86).
      leaveLabel:
        failure.leaveLabel ??
        (failure.retryable
          ? "Abandonner et revenir au tableau de bord"
          : "Revenir au tableau de bord"),
    },
  };
}
