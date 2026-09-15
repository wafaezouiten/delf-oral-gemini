"use client";

import type { OralTopic } from "@/lib/delf/topics";
import type { ExamController, ExamState } from "@/lib/live/exam-controller";
import { devTimeSkipAvailable } from "@/lib/ui/dev-time-skip";
import type { SavedExaminerPrompt } from "@/lib/ui/dev-examiner-prompt";
import { clearSavedExaminerPrompt, saveExaminerPrompt } from "@/lib/ui/dev-examiner-prompt-storage";

import { DevExaminerPromptPanel } from "./dev-examiner-prompt-panel";
import { DevTimeSkip } from "./dev-time-skip";
import { DevTranscriptionPanel } from "./dev-transcription-panel";

/**
 * The development cluster in the passation's corner — rendered only on a
 * build where `DEV_TOOLS_ENABLED` holds, which is the caller's check.
 *
 * Three controls, each for the part it means something in:
 *
 *  - the examiner prompt editor (#152), in the débat only. The monologue's
 *    examiner is silent by design — the transport withholds its turn, and its
 *    prompt's whole content is « tu écoutes et tu ne parles pas » — so a
 *    prompt experiment there has nothing observable to test;
 *  - the typed exposé (#36), in the monologue only, where the controller hands
 *    the microphone back when the part ends so it can be;
 *  - the time-skip (#149), while a part is actually running — the rule is
 *    `devTimeSkipAvailable`. In the cluster rather than the reference's
 *    `fixed bottom-24 left-4` pill, which sat on top of the conversation
 *    column the candidate is reading.
 *
 * The reconnect control that used to be here is gone: the recovery notice's
 * « Reprendre la connexion » is the same `forceReconnect()`, and it is the
 * one a candidate can reach.
 */
export function OralDevPanel({
  state,
  controller,
  topic,
  examinerModel,
  savedPrompt,
  promptPanelOpen,
  onPromptPanelOpen,
  awaitingConsigne,
}: {
  state: ExamState;
  controller: ExamController;
  topic: OralTopic;
  examinerModel: string;
  savedPrompt: SavedExaminerPrompt | null;
  promptPanelOpen: boolean;
  onPromptPanelOpen: (open: boolean) => void;
  awaitingConsigne: boolean;
}) {
  return (
    <div className="space-y-2">
      {state.phase === "debate" && (
        <DevExaminerPromptPanel
          topicSlug={topic.slug}
          examinerModel={examinerModel}
          active={promptPanelOpen}
          modified={state.examinerPromptModified}
          sessionOpen={state.examinerSessionOpen}
          saved={savedPrompt}
          onActiveChange={onPromptPanelOpen}
          onApply={(prompt, promptVersion) => {
            controller.setExaminerPrompt(prompt);
            controller.restartExaminerSession();
            saveExaminerPrompt(topic.slug, prompt, promptVersion);
          }}
          onReset={() => {
            controller.setExaminerPrompt(null);
            controller.restartExaminerSession();
            clearSavedExaminerPrompt(topic.slug);
          }}
        />
      )}

      {state.phase === "monologue" && (
        <DevTranscriptionPanel
          subject={topic.title}
          active={state.devTextMode}
          onActiveChange={(on) => controller.setDevTextMode(on)}
          awaitingConsigne={awaitingConsigne}
          closing={state.closing}
          onSubmit={(text, seconds) => controller.submitTypedExpose(text, seconds)}
        />
      )}

      {devTimeSkipAvailable(state) && (
        <DevTimeSkip
          onSkip={(seconds) => controller.devSkipTime(seconds)}
          onSkipToEnd={() => controller.devSkipToEnd()}
        />
      )}
    </div>
  );
}
