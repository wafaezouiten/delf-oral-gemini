"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ExitDialog } from "@/app/_components/po/exit-dialog";
import { QuitBeforeDebateDialog } from "@/app/_components/po/quit-before-debate-dialog";
import { QuitBeforeSpeakingDialog } from "@/app/_components/po/quit-before-speaking-dialog";
import { requestAbandon } from "@/lib/exams/abandon";
import { requestPreparationExit } from "@/lib/exams/preparation-exit";
import type { ExamController, ExamState } from "@/lib/live/exam-controller";
import { examExitRoute, type ExamExitRoute } from "@/lib/ui/exam-exit";

/**
 * The three ways out of an épreuve, and the dialog each opens.
 *
 * Which one « Quitter » opens is `examExitRoute`'s decision, tested in
 * `lib/ui/exam-exit.ts`: before anything is said the sitting is archived
 * (#113), between the exposé and the débat it is finished without one (#199),
 * and once the candidate has spoken it is a walk-out that scores zero (#38).
 * What each route then does with the server is `abandon.ts` and
 * `preparation-exit.ts`'s. This hook holds the pending and failure state the
 * dialogs draw, and the one navigation.
 */
export function useExamExit(examId: string, controller: ExamController) {
  const router = useRouter();
  const [prompt, setPrompt] = useState<ExamExitRoute | null>(null);
  const [abandoning, setAbandoning] = useState(false);
  const [abandonFailed, setAbandonFailed] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [finishingWithoutDebate, setFinishingWithoutDebate] = useState(false);

  const leave = () => router.push("/app");

  // The walk-out is a promise the dialog made — « this counts as a zero » —
  // so a record that could not be written is surfaced and offered again,
  // with a way to leave regardless (#38).
  const abandon = async () => {
    if (abandoning) return;
    setAbandoning(true);
    setAbandonFailed(false);
    const outcome = await requestAbandon(examId);
    if (!outcome.recorded) {
      console.warn("[abandon] the walk-out was not recorded on the server", outcome);
      setAbandoning(false);
      setAbandonFailed(true);
      return;
    }
    leave();
    router.refresh();
  };

  // The préparation's exit promises the ABSENCE of a record, which an exit
  // that never reached the server produces anyway: logged, and left (#113).
  const quitWithoutRecord = async () => {
    if (quitting) return;
    setQuitting(true);
    const outcome = await requestPreparationExit(examId);
    if (!outcome.recorded) {
      console.warn("[preparation] the exit was not archived on the server", outcome);
    }
    leave();
  };

  // Finishing without the débat is the controller's: the phase flips to
  // `finished` and the finish handler takes over. If it refused — the sitting
  // is not where the dialog thought — the dialog is released rather than
  // stuck pending (#199).
  const quitBeforeDebate = async () => {
    if (finishingWithoutDebate) return;
    setFinishingWithoutDebate(true);
    await controller.finishWithoutDebate();
    if (controller.getSnapshot().phase === "debate") setFinishingWithoutDebate(false);
    setPrompt(null);
  };

  const open = (state: ExamState) => setPrompt(examExitRoute(state.phase, state.awaitingStart));
  const close = () => {
    setPrompt(null);
    setAbandonFailed(false);
  };

  return {
    leave,
    open,
    dialogs: {
      prompt,
      abandoning,
      abandonFailed,
      quitting,
      finishingWithoutDebate,
      close,
      abandon,
      quitWithoutRecord,
      quitBeforeDebate,
    },
  };
}

/** The three dialogs, one of which is open at a time — or none. */
export function ExamExitDialogs({
  phase,
  dialogs,
  onLeave,
}: {
  phase: ExamState["phase"];
  dialogs: ReturnType<typeof useExamExit>["dialogs"];
  onLeave: () => void;
}) {
  return (
    <>
      <QuitBeforeSpeakingDialog
        open={dialogs.prompt === "archive"}
        stage={phase === "preparation" ? "preparation" : "monologue"}
        pending={dialogs.quitting}
        onCancel={dialogs.close}
        onConfirm={() => void dialogs.quitWithoutRecord()}
      />
      <QuitBeforeDebateDialog
        open={dialogs.prompt === "finish"}
        pending={dialogs.finishingWithoutDebate}
        onCancel={dialogs.close}
        onConfirm={() => void dialogs.quitBeforeDebate()}
      />
      <ExitDialog
        open={dialogs.prompt === "abandon"}
        pending={dialogs.abandoning}
        failed={dialogs.abandonFailed}
        onCancel={dialogs.close}
        onConfirm={() => void dialogs.abandon()}
        onLeaveAnyway={onLeave}
      />
    </>
  );
}
