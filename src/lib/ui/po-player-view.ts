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

import { ORAL_PARTS_B2, getOralPartSpec } from "@/lib/delf/constants";
import {
  MONOLOGUE_MIN_SECONDS,
  PHASE_DURATIONS,
  formatClock,
  type OralPhase,
} from "@/lib/delf/phases";

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

/** The rest of the part's name, for the briefing's serif subtitle. */
export function partSubtitle(title: string): string {
  return title
    .split(/\s+[—–:-]\s+/)
    .slice(1)
    .join(" · ")
    .trim();
}

// =====================================================
// THE DÉROULÉ
// =====================================================

/** One phase of the épreuve, as the briefing's numbered rail prints it. */
export interface PoDerouleStep {
  /** 1-based position, printed in the numbered chip. */
  n: number;
  title: string;
  /** "30:00", "7:00" — never a bare constant. */
  durationLabel: string;
  caption: string;
}

/**
 * The ordered phases of the épreuve, for the briefing rail.
 *
 * Built from `PHASE_DURATIONS` rather than from an `OralPartSpec` the way the
 * reference does it, because the durations the candidate is about to live
 * through are the state machine's, and those are what the clocks will count.
 * Reading them from anywhere else is how a briefing ends up promising seven
 * minutes of a monologue the timer gives five.
 *
 * The captions are the part descriptions' first clause, same as the reference.
 */
export function buildDeroule(): PoDerouleStep[] {
  return [
    {
      n: 1,
      title: "Préparation",
      durationLabel: formatClock(PHASE_DURATIONS.preparation),
      caption: "Sujet en main, notes autorisées",
    },
    {
      n: 2,
      title: "Monologue suivi",
      durationLabel: formatClock(PHASE_DURATIONS.monologue),
      caption: firstClause(partDescription(1)),
    },
    {
      n: 3,
      title: "Débat",
      durationLabel: formatClock(PHASE_DURATIONS.debate),
      caption: "L'examinateur conteste votre position ; défendez-la.",
    },
  ];
}

function partDescription(tache: number): string {
  return getOralPartSpec(tache)?.description ?? "";
}

/**
 * First sentence of a description, trimmed for a one-line caption, with a
 * trailing parenthetical duration hint ("(~5–7 min)") dropped — the duration is
 * already the row's right-hand column, and printing it twice on one line is how
 * the reference's caption used to read.
 */
function firstClause(text: string): string {
  const sentence = text.split(/[.!?]/)[0]?.trim() ?? text.trim();
  return sentence.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// =====================================================
// THE PRÉPARATION RAIL
// =====================================================

/**
 * The plan the candidate is expected to follow while speaking, printed in the
 * préparation rail as « Structure attendue ».
 *
 * The reference chooses between an argued arc and a conversational checklist
 * per `(level, type)`. B2's monologue suivi is argued and hands off to a débat,
 * so only the argued arc has a caller here — the checklist branch is dropped
 * rather than kept unreachable.
 */
export function structureSteps(): string[] {
  return [
    "Introduire le thème et la problématique",
    "Développer 2 ou 3 arguments illustrés",
    "Conclure par une position claire",
    "Défendre son point de vue au débat",
  ];
}

// =====================================================
// THE PASSATION
// =====================================================

/**
 * The named beats of the passation, for the scene's inner stepper.
 *
 * Two, always, and that is the shape of the B2 épreuve: a prepared exposé, then
 * the examiner's challenge. This is NOT the top-level `Sujet / Préparation /
 * Passage` stepper in the topbar — that one tracks the three screens; this one
 * tracks the beats inside the passation.
 */
export const PASSATION_BEATS: readonly string[] = ["Exposé", "Débat"];

/**
 * Which beat the candidate is in.
 *
 * Read off the phase, not estimated from the clock. The reference has to
 * approximate — one conversation, no boundary — and says so in a comment
 * apologising for the ratio. Here the boundary is a state transition, so the
 * stepper is exact and a candidate who finishes their monologue early sees the
 * pill move when they actually move.
 */
export function activeBeat(phase: SpeakingPhase): number {
  return phase === "monologue" ? 0 : 1;
}

/**
 * The hint printed under the mic, and the mic's accessible name.
 *
 * Both name the actual task, per the reference: a débat is not an "exposé", and
 * the label is the only name a screen-reader user gets for the control. The
 * `locked` state is this project's own — the mic ends the monologue, and the
 * monologue may not end before the DELF's five-minute floor (`canAdvanceEarly`).
 * The reference has no analogue because its mic ends the whole conversation and
 * a candidate may always do that.
 */
export function micCopy(
  phase: SpeakingPhase,
  state: "recording" | "locked" | "connecting",
  remainingToFloorSeconds = 0,
): { hint: string; label: string } {
  const act = phase === "monologue" ? "votre exposé" : "le débat";

  if (state === "connecting") {
    return { hint: "Connexion à l'examinateur…", label: `Terminer ${act}` };
  }

  if (state === "locked") {
    const minutes = Math.ceil(remainingToFloorSeconds / 60);
    return {
      // Said as time still to fill rather than as a refusal: the candidate is
      // not being blocked, they are being told the task is not done yet.
      hint: `Encore ${minutes} min avant de pouvoir conclure`,
      label: `Terminer ${act} — disponible dans ${minutes} minutes`,
    };
  }

  return {
    hint: `Appuyez pour terminer ${act}`,
    label: `Terminer ${act}`,
  };
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
): { title: string; body: string } {
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

/** The examiner's status line, on the left of the scene. */
export function examinerStatus(options: {
  connected: boolean;
  connecting: boolean;
  speaking: boolean;
}): string {
  if (options.connecting) return "Connexion en cours…";
  if (!options.connected) return "L'examinateur n'est pas en ligne.";
  if (options.speaking) return "L'examinateur intervient…";
  return "Vous écoute attentivement.";
}

/** The candidate's own status line, mirrored on the right of the scene. */
export function candidateStatus(options: {
  connected: boolean;
  examinerSpeaking: boolean;
  recording: boolean;
}): string {
  if (options.examinerSpeaking) return "En écoute…";
  if (!options.recording) return "Microphone en attente";
  if (!options.connected) return "Enregistrement en cours";
  return "Vous avez la parole";
}

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
 * The topbar's step index: 0 Sujet, 1 Préparation, 2 Passage.
 *
 * `finished` maps to the passage rather than to a fourth step, because the
 * reference's stepper has three positions and the finished screen is the
 * évaluation's loading state rather than a step of the épreuve.
 */
export function topbarStep(phase: OralPhase, started: boolean): number {
  if (!started) return 0;
  return phase === "preparation" ? 1 : 2;
}

/** The two part titles, for the briefing's serif headline. */
export const MONOLOGUE_TITLE = ORAL_PARTS_B2[0].title;
export const DEBATE_TITLE = ORAL_PARTS_B2[1].title;
