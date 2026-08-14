/**
 * The phonologie instruction: the ONE place the two evaluation modes genuinely
 * differ, and the only part of the corrector's prompt that depends on which
 * recordings actually exist.
 *
 * It lives in its own module, away from `evaluate.ts`, for the same reason
 * `lib/delf/examiner-prompt.ts` does: `evaluate.ts` imports `server-only` and
 * therefore cannot be loaded by the unit suite, and a prompt that decides how a
 * criterion is graded is exactly the kind of string that should be asserted
 * rather than read.
 *
 * What it has to get right is attribution. Phase 6 records each task separately
 * and a task can fail to record on its own — a microphone denied before the
 * monologue, a headset unplugged four minutes into the débat — so "one
 * recording" is a real outcome while the transcript still contains both tasks.
 * A model handed one file and told only "here is the candidate's audio" will
 * cheerfully assume it covers the whole épreuve and attribute the wrong half's
 * hesitations to it. Naming what is present is what stops a missing recording
 * turning into a wrong phonologie band.
 */

import type { EvaluationMode, OralSpeakingPhase } from "@/lib/db/schema";

/** How the corrector's prompt names each task. Upper case because the rest of
 *  the prompt refers to them that way. */
const TASK_LABELS: Record<OralSpeakingPhase, string> = {
  monologue: "MONOLOGUE SUIVI",
  debate: "DEBAT",
};

/**
 * One recording attached to an evaluation, reduced to the only thing this
 * module needs from it.
 *
 * `phase` is null for a recording that is not attributable to one task — a
 * whole-sitting file, which is what the verification scripts and the
 * audio-versus-text experiment hand over.
 */
export interface AttachedRecording {
  phase: OralSpeakingPhase | null;
}

const TEXT_INSTRUCTION = `PHONOLOGIE : vous ne disposez QUE de la transcription, sans le son. Vous ne pouvez donc pas juger la prononciation elle-même. Jugez uniquement les indices de fluidité visibles dans le texte : hésitations (« euh », « hum »), faux départs, autocorrections, répétitions, énoncés abandonnés ou fragmentés. Beaucoup de ces marques indiquent un débit haché : notez bas. Un texte fluide et des phrases menées à terme : notez 3, voire 5 si la fluidité est remarquable sur toute la durée. Mettez « phonologieNonEvaluable » à true si la production est trop brève pour juger quoi que ce soit.`;

/**
 * What the corrector is told about the audio it has been given.
 *
 * The one-recording case carries an explicit instruction not to penalise the
 * missing half. Otherwise a model that has been told the épreuve has two tasks
 * and handed the audio of one draws the obvious, wrong conclusion about the
 * other — and a candidate whose microphone died gets marked down twice for it,
 * once by the duration penalty that is already measuring the shortfall honestly
 * and once by a phonologie band inferred from silence.
 */
function coverage(recordings: readonly AttachedRecording[]): string {
  const named = recordings
    .map((recording) => recording.phase)
    .filter((phase): phase is OralSpeakingPhase => phase !== null);

  if (named.length === 0) return ` Il couvre l'ensemble de l'épreuve.`;

  if (named.length === 1) {
    const missing = named[0] === "monologue" ? TASK_LABELS.debate : TASK_LABELS.monologue;
    return ` ATTENTION : cet enregistrement couvre UNIQUEMENT le ${TASK_LABELS[named[0]]}. Le ${missing} n'a pas pu être enregistré (microphone indisponible ou interrompu). Jugez la phonologie sur ce seul extrait, et ne pénalisez pas le candidat pour la partie manquante : son absence n'est pas une faiblesse de sa prestation.`;
  }

  // Fournis, et lus, dans l'ordre de l'épreuve.
  return ` Les enregistrements sont fournis dans l'ordre de l'épreuve : ${named
    .map((phase) => `le ${TASK_LABELS[phase]}`)
    .join(", puis ")}.`;
}

export function phonologyInstruction(
  mode: EvaluationMode,
  recordings: readonly AttachedRecording[] = [],
): string {
  if (mode !== "audio") return TEXT_INSTRUCTION;

  const plural = recordings.length > 1;
  const opening = plural
    ? `vous disposez des ENREGISTREMENTS AUDIO réels du candidat.`
    : `vous disposez de l'ENREGISTREMENT AUDIO réel du candidat.`;

  return `PHONOLOGIE : ${opening}${coverage(recordings)} ${
    plural ? "Écoutez-les" : "Écoutez-le"
  } et jugez la prononciation, l'accentuation, le rythme, l'intonation, la fluidité et l'intelligibilité effectives. Appuyez votre note sur ce que vous entendez, en citant des exemples précis (sons mal réalisés, syllabes accentuées à tort, débit, pauses). Ne déduisez PAS la phonologie du texte : vous avez le son.`;
}
