"use client";

import { Notice } from "@/app/_components/notice";
import { dangerButton } from "@/app/_components/button-styles";
import type { ExamState } from "@/lib/live/exam-controller";

/**
 * Whether there is anything for {@link ExamNotices} to say, so the screens can
 * leave their notice slot empty rather than render an empty fragment into it.
 */
export function hasExamNotices(state: ExamState, canEncode: boolean | null): boolean {
  return state.status === "error" || Boolean(state.micError) || canEncode === false;
}

/**
 * What the candidate is told above the screen: the connection is lost (with
 * the one recovery they can reach), the microphone refused, and — on the
 * préparation only, where there is still time to change browser — that this
 * one cannot encode the recording.
 */
export function ExamNotices({
  state,
  canEncode,
  onReconnect,
}: {
  state: ExamState;
  /** `null` until the browser has answered, or when it never did; the
   *  encoding notice is for a definite no. Pass `null` off the préparation. */
  canEncode: boolean | null;
  onReconnect: () => void;
}) {
  return (
    <>
      {state.status === "error" && (
        <Notice
          tone="danger"
          title="La connexion avec l'examinateur est perdue"
          action={
            <button type="button" onClick={onReconnect} className={dangerButton}>
              Reprendre la connexion
            </button>
          }
        >
          Les tentatives automatiques de reconnexion n&apos;ont pas abouti. Le temps de cette partie
          continue de s&apos;écouler et ce qui a déjà été dit est conservé. Vérifiez votre connexion
          internet, puis reprenez.
        </Notice>
      )}

      {state.micError && (
        <Notice tone="warning" title="Microphone">
          {state.micError}
        </Notice>
      )}

      {canEncode === false && (
        <Notice tone="danger" title="Votre navigateur ne peut pas envoyer l'enregistrement">
          Il ne sait pas compresser l&apos;audio. Votre prestation sera corrigée à partir de la
          transcription seule, sans écoute de votre prononciation, et la pénalité de durée
          s&apos;appliquera comme si aucun enregistrement n&apos;existait. Passez plutôt
          l&apos;épreuve sur une version récente de Chrome, Edge, Safari ou Firefox.
        </Notice>
      )}
    </>
  );
}
