/**
 * Everything the production orale screens *print*, derived here rather than
 * inside a component.
 *
 * PORT NOTE: this is `src/lib/quiz/po-player-view.ts` from the reference
 * implementation, narrowed to B2. The reference keys every one of these on
 * `(level, OralPartType)` because its catalogue runs A1 through B2 and a part's
 * shape differs at each; this project has exactly one épreuve — a monologue
 * suivi followed by a débat — so the level parameter has nowhere to come from
 * and the `entretien` / `echange` / `interaction` / `point_de_vue` branches have
 * no caller. What survives is the same set of strings, keyed on the phase.
 *
 * The bigger departure is the déroulé and the beats. The reference derives both
 * from an `OralPartSpec`, and approximates which beat the candidate is in from a
 * 40 % share of the speaking clock, because ElevenLabs hands it one continuous
 * conversation with no boundary in it. This project's exam is a state machine
 * with two real speaking phases and a clock each, so the beat is *read* rather
 * than estimated. Same two pills on screen; one of them is now a fact.
 *
 * React-free so it can be unit-tested with `node:test`, which is this repo's
 * definition of done for logic.
 */

import { ORAL_PARTS_B2 } from "@/lib/delf/constants";
import { MONOLOGUE_MIN_SECONDS, type OralPhase } from "@/lib/delf/phases";

/** The phases the candidate actually speaks in — the two that have a mic. */
export type SpeakingPhase = "monologue" | "debate";

// =====================================================
// THE MASTHEAD
// =====================================================

/** "Production orale · DELF B2 · Monologue suivi" — the topbar's identity line. */
export function poKicker(partLabel: string): string {
  return `Production orale · DELF B2 · ${partLabel}`;
}

/**
 * A part's name without its em-dashed tail: "Monologue suivi", not the whole
 * "Monologue suivi : présenter et défendre un point de vue".
 *
 * The separator class is the reference's — em dash, en dash or hyphen — because
 * the titles in `constants.ts` were ported from that catalogue and use a colon
 * *and* a dash across the two rows. Splitting on all of them means a title
 * rewritten in either style still yields a short label rather than the full line.
 */
export function shortPartLabel(title: string): string {
  return title.split(/\s+[—–:-]\s+/)[0].trim();
}

/*
 * `partSubtitle` — the rest of a part's name, for a serif subtitle — went with
 * the briefing screen (#55). Its only caller was that screen's headline, and the
 * préparation prints the sujet's own title rather than the part's.
 */

/*
 * `buildDeroule` — the numbered "Déroulé de la séance" list — is gone with its
 * card. It survived the briefing screen's deletion (#55) by moving to the
 * préparation rail; the rail was reordered on the user's call and the card
 * dropped, so the list's durations now live in exactly one place the candidate
 * meets them: the sujet's launch dialog.
 */

// =====================================================
// THE PRÉPARATION RAIL
// =====================================================

/** One beat of the exposé's plan: what to do, and how. */
export interface PlanStep {
  title: string;
  detail: string;
}

/**
 * The plan the candidate is expected to follow while speaking.
 *
 * **One list, two screens.** It is « Structure attendue » in the préparation
 * rail and « Votre plan » on the exposé, and it used to be two separate lists
 * written in two different voices — the rail said "Introduire le thème et la
 * problématique", the exposé screen had nothing at all. Now the plan the
 * candidate reads while preparing is the same plan that stays in front of them
 * while they speak, which is the only version of this that is any use: a
 * structure you are shown once during préparation and never again is a structure
 * you improvise from memory.
 *
 * Four beats, and the third is the one worth keeping distinct from the second.
 * B2's « présenter et défendre un point de vue » is graded on the candidate
 * taking a position, not on their surveying the arguments — so « Point de vue »
 * is its own step, with the concession that makes it read as B2 rather than B1.
 *
 * The reference chooses between an argued arc and a conversational checklist
 * per `(level, type)`. B2's monologue suivi is argued and hands off to a débat,
 * so only the argued arc has a caller here.
 */
export const EXPOSE_PLAN: readonly PlanStep[] = [
  {
    title: "Introduction",
    detail: "Présentez le document, puis dégagez une problématique.",
  },
  {
    title: "Développement",
    detail: "Deux parties au moins, chacune avec un exemple.",
  },
  {
    title: "Point de vue",
    detail: "Amenez votre avis par une concession (« Néanmoins… »).",
  },
  {
    title: "Conclusion",
    detail: "Faites le bilan, puis rendez la parole.",
  },
] as const;

// =====================================================
// THE PASSATION
// =====================================================

/*
 * `PASSATION_BEATS` and `activeBeat` used to live here, feeding a second stepper
 * drawn inside the conversation scene. Both are gone with that scene: the topbar
 * names Préparation, Exposé and Débat now, so the beats are the steps and there
 * is nothing left for an inner stepper to say that the outer one does not.
 */

/**
 * What the record control is doing.
 *
 * `armed` is the part that has not started: the consigne has been given, the
 * sujet and the plan are on screen, and no clock is running until the candidate
 * says they are ready. The other three are the part in progress.
 */
export type MicState = "armed" | "recording" | "locked" | "connecting" | "closing";

/**
 * The word on the record control, the hint printed under it, and its accessible
 * name.
 *
 * All three name the actual task, per the reference: a débat is not an "exposé",
 * and the label is the only name a screen-reader user gets for the control. The
 * `locked` state is this project's own — the control ends the monologue, and the
 * monologue may not end before the DELF's floor (`canAdvanceEarly`). The
 * reference has no analogue because its mic ends the whole conversation and a
 * candidate may always do that.
 *
 * The visible `button` word is new with the sujet-on-screen layout. The control
 * used to be an icon alone, which was legible while it only ever meant "stop":
 * now that the same control also *starts* a part, an icon that is a square in
 * one state and a circle in another is not enough to tell a candidate which of
 * those is about to happen.
 */
export function micCopy(
  phase: SpeakingPhase,
  state: MicState,
  remainingToFloorSeconds = 0,
): { hint: string; label: string; button: string } {
  const act = phase === "monologue" ? "votre exposé" : "le débat";

  // The part has not begun. The candidate has read the sujet and the plan with
  // no clock running, and this is the button that starts both the clock and the
  // recording — so it is the one state where the control says what it *starts*
  // rather than what it ends.
  if (state === "armed") {
    return {
      button: "Enregistrer",
      hint: `Cliquez pour commencer ${act}.`,
      label: `Commencer ${act}`,
    };
  }

  if (state === "connecting") {
    return {
      button: "Connexion…",
      hint: "Connexion à l'examinateur…",
      label: `Terminer ${act}`,
    };
  }

  // The click has been taken and the part is ending (#55). Said here because the
  // control is where the candidate is looking when they press it, and what
  // follows — the examiner's closing sentence, then the next consigne — takes
  // several seconds during which nothing else on screen changes. « Terminé »
  // rather than « Terminer »: the button is no longer an offer.
  if (state === "closing") {
    return {
      button: "Terminé",
      hint:
        phase === "monologue"
          ? "Fin de l'exposé. L'examinateur conclut, puis vous donne la consigne du débat."
          : "Fin du débat. L'examinateur conclut, puis votre prestation part pour correction.",
      label: phase === "monologue" ? "Exposé terminé" : "Débat terminé",
    };
  }

  if (state === "locked") {
    const minutes = Math.ceil(remainingToFloorSeconds / 60);
    return {
      button: "Terminer",
      // Said as time still to fill rather than as a refusal: the candidate is
      // not being blocked, they are being told the task is not done yet.
      hint: `Encore ${minutes} min avant de pouvoir conclure`,
      label: `Terminer ${act} — disponible dans ${minutes} minutes`,
    };
  }

  // Two sentences, and the first one is the point: the candidate is speaking
  // *now*, and the single most common confusion on this screen is not knowing
  // whether the microphone is live. "Vous parlez." answers that before the
  // instruction does — the badge and the pulsing ring say the same thing, and
  // this is the one place it is said in words next to the control itself.
  return {
    button: "Terminer",
    hint: `Vous parlez. Cliquez pour terminer ${act}.`,
    label: `Terminer ${act}`,
  };
}

/**
 * The examiner's status line, under their name in the scene (#60).
 *
 * Restored with the scene it belongs to. It was deleted in #37, when the two
 * faces came off the passation and their status lines went with them; the débat
 * has them back, because a screen that prints nothing of what is said needs
 * *something* that says who is talking.
 *
 * The order of the branches is the whole of it. Each one outranks the ones below
 * because it describes a state in which the lower answer is a lie, not merely a
 * less interesting truth.
 */
export function examinerStatus(options: {
  connected: boolean;
  connecting: boolean;
  speaking: boolean;
  /**
   * A recorded consigne is playing (#37).
   *
   * First, because it is the one state where the examiner is audible with no
   * session behind them: without it this said « L'examinateur n'est pas en ligne »
   * over the sound of the examiner talking.
   */
  announcing?: boolean;
  /**
   * The part has been ended and the examiner is finishing their turn (#55).
   *
   * Above the connection for the same reason as `announcing`: the socket is being
   * torn down while the voice is still audible, so the honest answer is that they
   * are speaking, not that they have gone.
   */
  closing?: boolean;
  /**
   * The débat's opening question is on its way and nothing is audible yet.
   *
   * Below `speaking`, because the moment the voice starts, « intervient » is the
   * truer sentence; below the connection checks, because while the socket is
   * still connecting that is the better explanation for the silence. What it
   * replaces is the default: « Vous écoute attentivement » over an examiner who
   * is about to ask told the candidate the floor was theirs.
   */
  opening?: boolean;
}): string {
  if (options.announcing) return "L'examinateur donne la consigne…";
  if (options.closing) return "L'examinateur conclut…";
  if (options.connecting) return "Connexion en cours…";
  if (!options.connected) return "L'examinateur n'est pas en ligne.";
  if (options.speaking) return "L'examinateur intervient…";
  if (options.opening) return "L'examinateur prépare sa question…";
  return "Vous écoute attentivement.";
}

/** The candidate's own status line, mirrored on the right of the scene (#60). */
export function candidateStatus(options: {
  connected: boolean;
  examinerSpeaking: boolean;
  recording: boolean;
}): string {
  // Listening outranks the microphone: both are true while the examiner
  // interrupts, and « Vous avez la parole » beside a talking examiner is the one
  // that misleads.
  if (options.examinerSpeaking) return "En écoute…";
  if (!options.recording) return "Microphone en attente";
  if (!options.connected) return "Enregistrement en cours";
  return "Vous avez la parole";
}

/**
 * The body of the passation's quiet status card.
 *
 * The reference prints an "en attente" hint until the candidate opens the
 * socket, then a running one. Here the socket opens with the phase, so the
 * waiting state belongs to the connection rather than to the candidate — which
 * is why this takes the phase and whether the examiner is there, and never says
 * "cliquez sur le micro pour commencer".
 */
export function passationStatus(
  phase: SpeakingPhase,
  connected: boolean,
  /**
   * The phase is open but has not started: its consigne is being spoken, or is
   * waiting for a click because the browser refused to play it (#37).
   *
   * Checked before everything else because both of the claims below become false
   * in that window, and they are the two the candidate is most entitled to rely
   * on: nothing is being recorded yet, and the clock has not begun. The window
   * used to be milliseconds wide and is now twenty-five seconds of audible
   * speech, which is long enough to read a sentence and believe it.
   */
  awaitingConsigne = false,
  /**
   * The part has been ended and the examiner is delivering its closing sentence
   * (#55). Several seconds pass before the next consigne is spoken, and until
   * this was rendered nothing on screen acknowledged the click at all — so the
   * candidate's own « Terminer » looked ignored, on the one screen where pressing
   * it twice is exactly what should not happen.
   */
  closing = false,
): { title: string; body: string } {
  if (closing) {
    return phase === "monologue"
      ? {
          title: "Fin de l'exposé",
          body: "L'examinateur termine la première partie. Il vous donnera la consigne du débat dans un instant.",
        }
      : {
          title: "Fin du débat",
          body: "L'examinateur conclut l'épreuve. Votre prestation part ensuite pour correction.",
        };
  }

  if (awaitingConsigne) {
    return {
      title: "Consigne de l'examinateur",
      body: "Écoutez la consigne. Rien n'est enregistré pour l'instant et le temps de cette partie n'a pas encore commencé à courir : il démarrera quand l'examinateur aura fini de parler.",
    };
  }

  if (!connected) {
    return {
      title: "Connexion à l'examinateur",
      body: "Votre prise de parole est enregistrée dès maintenant. L'examinateur vous rejoint dans un instant ; le temps de cette partie a déjà commencé à courir.",
    };
  }

  if (phase === "monologue") {
    return {
      title: "Monologue en cours",
      body: "Parlez sans vous interrompre : l'examinateur écoute et ne vous coupera pas. La transcription de votre exposé s'affichera en une seule fois à la fin.",
    };
  }

  return {
    title: "Débat en cours",
    body: "Répondez aux objections de l'examinateur et défendez votre position. Suivez le temps en haut ; l'épreuve se termine automatiquement à la fin du chronomètre.",
  };
}

/*
 * `examinerStatus` and `candidateStatus` were the two lines under the examiner
 * and candidate faces, and they went with the faces. What they carried is not
 * lost: whether the examiner is there is `passationStatus`'s sentence, and
 * whether the microphone is live is said at the control itself by `micCopy` —
 * which is the better place for it, since that is where a candidate wondering
 * about it is already looking.
 */

// =====================================================
// THE FLOOR
// =====================================================

/**
 * How long is still owed before the monologue may be ended early, floored at 0.
 *
 * The rule itself is `canAdvanceEarly`'s in `phases.ts`; this only turns it into
 * the number the mic hint prints, so the button's disabled state and the
 * sentence explaining it are computed from one subtraction rather than two.
 */
export function secondsToMonologueFloor(elapsedSeconds: number): number {
  return Math.max(0, MONOLOGUE_MIN_SECONDS - Math.floor(elapsedSeconds));
}

/**
 * A rewound start stamp that makes the derived elapsed time jump forward by
 * `skipSeconds`. Because elapsed is `(now - start)`, moving the start *earlier*
 * advances the clock — the mechanism behind the dev fast-forward tool, which
 * lets a tester reach time-up (and the real close-out handshake) without waiting
 * out the full épreuve. A non-positive skip is a no-op, so it never rewinds time.
 *
 * PORT NOTE: `rewindStartBy` from the reference's `po-player-view.ts`, verbatim
 * in behaviour. There the tool was admin-gated on the live session; here it is
 * development-gated (`DEV_TOOLS_ENABLED`) and the stamp it rewinds is the
 * controller's `phaseStart`, but the arithmetic — and the property that nothing
 * bypasses the finalize path — is the same.
 */
export function rewindStartBy(startMs: number, skipSeconds: number): number {
  return startMs - Math.max(0, skipSeconds) * 1000;
}

/**
 * The topbar's step index: 0 Préparation, 1 Exposé, 2 Débat.
 *
 * **The stepper now names the épreuve's parts rather than this app's screens.**
 * It used to read `Sujet · Préparation · Passage`, which tracked the three
 * screens and folded the monologue and the débat into one — so a candidate
 * halfway through the épreuve was told they were on the last step, and a second
 * stepper inside the scene had to exist to say which half of it they were in.
 * Naming the two parts here is what makes that inner stepper unnecessary, and it
 * matches what the candidate is actually being examined on: a DELF B2 production
 * orale has a préparation, an exposé and a débat.
 *
 * `finished` maps to the débat, because the finished screen is the évaluation's
 * loading state rather than a fourth part.
 *
 * It used to take a `started` flag as well, for the briefing screen that stood
 * before the préparation. That screen is gone (#55) and the flag went with it —
 * the épreuve now opens on the phase it is in, and the phase is the whole answer.
 */
export function topbarStep(phase: OralPhase): number {
  switch (phase) {
    case "preparation":
      return 0;
    case "monologue":
      return 1;
    default:
      return 2;
  }
}

/**
 * The part heading over the sujet on the passation screen: « Partie 1 · Monologue
 * suivi ».
 *
 * The number is the DELF's own `tache`, read off the part spec rather than
 * written here, so it cannot disagree with the duration and the penalty floor
 * that are keyed on the same number.
 */
export function partieKicker(phase: SpeakingPhase): string {
  const spec = phase === "monologue" ? ORAL_PARTS_B2[0] : ORAL_PARTS_B2[1];
  return `Partie ${spec.tache} · ${shortPartLabel(spec.title)}`;
}

/** The passation's footer line. */
export const SITE_FOOTER = "DELF Formation · Préparez le DELF B2";

/** The two part titles, for the topbar's identity line and the sujet kickers. */
export const MONOLOGUE_TITLE = ORAL_PARTS_B2[0].title;
export const DEBATE_TITLE = ORAL_PARTS_B2[1].title;
