import { micCopy, micState, type MicState, type SpeakingPhase } from "./po-player-view";

/**
 * What the control bar decides, decided here (#234): what the one button is
 * — the armed « Enregistrer », the live stop, the inert « Terminé », the
 * spinner — when it is pressable, whether it pulses, and whether « Terminer
 * l'épreuve » may be pressed. The words are `micCopy`'s; the state
 * `micState`'s. The component maps a look to classes and nothing more.
 */

export interface ControlsInput {
  phase: SpeakingPhase;
  canAdvance: boolean;
  connecting: boolean;
  recording: boolean;
  awaitingStart: boolean;
  /** Where the consigne is still playing, the armed button waits for it. */
  startDisabled: boolean;
  closing: boolean;
  emptyTranscript: boolean;
  hasDevPanel: boolean;
}

export interface MicButtonView {
  state: MicState;
  /** Which of the four buttons it is. */
  look: "armed" | "recording" | "inert" | "primary";
  /** The armed button starts the part; every other one ends it. */
  action: "start" | "advance";
  disabled: boolean;
  /** The red ring, following the fact of recording rather than the button's
   *  enabled state — it keeps pulsing through the closing handshake, when the
   *  candidate is still being recorded. Never while armed: nothing is being
   *  captured yet, and a ring over a part that has not started is the same
   *  false claim the recording badge is written to avoid. */
  pulsing: boolean;
  icon: "mic" | "loading" | "stop";
  label: string;
  text: string;
  hint: string;
}

export interface ControlsView {
  mic: MicButtonView;
  finish: { disabled: boolean; title: string | undefined };
  /** The alert and the development panel share one corner, or there is none. */
  corner: boolean;
}

const DEBATE_FIRST = "Le débat doit avoir lieu avant la fin de l'épreuve.";

/** Which button each state is; only a live part has two looks, by the microphone. */
function micLook(state: MicState, recording: boolean): MicButtonView["look"] {
  if (state === "armed") return "armed";
  if (state === "closing") return "inert";
  return recording ? "recording" : "primary";
}

const MIC_ICON: Record<MicState, MicButtonView["icon"]> = {
  armed: "mic",
  connecting: "loading",
  closing: "loading",
  recording: "stop",
};

export function controlsView(input: ControlsInput): ControlsView {
  const state = micState({
    awaitingStart: input.awaitingStart,
    closing: input.closing,
    connecting: input.connecting,
  });
  const { hint, label, button } = micCopy(input.phase, state);
  const armed = state === "armed";
  const inert = state === "closing";

  return {
    mic: {
      state,
      look: micLook(state, input.recording),
      action: armed ? "start" : "advance",
      disabled: armed ? input.startDisabled : inert || input.connecting,
      pulsing: input.recording && !armed,
      icon: MIC_ICON[state],
      label,
      text: button,
      hint,
    },
    finish: {
      disabled: input.phase !== "debate" || !input.canAdvance,
      title: input.phase === "debate" ? undefined : DEBATE_FIRST,
    },
    corner: input.emptyTranscript || input.hasDevPanel,
  };
}
