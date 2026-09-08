/**
 * What the corrector is told when the examiner tried to end the épreuve early
 * (#92) — the prompt half of the same incident `lib/delf/early-closing.ts`
 * detects and `oral_exams.early_closing_count` records.
 *
 * It lives in its own module, away from `evaluate.ts`, for the same reason
 * `phonology-instruction.ts` does: `evaluate.ts` imports `server-only` and
 * therefore cannot be loaded by the unit suite, and a paragraph that decides
 * what a shortened débat costs is exactly the kind of string that should be
 * asserted rather than read.
 *
 * Why the corrector has to be told at all: `formatTranscript` hands it every
 * examiner turn, so a débat carrying « L'épreuve est terminée. Vous pouvez
 * quitter la salle. » in its middle is in front of the model that produces the
 * marks — and in audio mode the goodbye is in the recording too, which is why
 * this paragraph speaks about what the model *hears* as well as what it reads.
 * Without it, the fault reads as the shape of the exchange: an « interaction »
 * that petered out, a candidate who stopped defending their position.
 *
 * What is deliberately NOT here: any arithmetic. The débat's penalties are
 * waived by `orale-rubric.ts` (`SittingConditions.examinerClosedEarly`), where
 * the rule is tested; this paragraph only stops the five bands themselves from
 * absorbing the fault. A prompt that also promised « aucune pénalité » would be
 * a second implementation of the waiver, written in French (#9).
 */

/**
 * The incident paragraph, or nothing.
 *
 * Empty when nothing was heard, rather than a reassuring "the examiner behaved"
 * line: the ordinary sitting's prompt should not change shape for a fault it
 * did not have, and `EVAL_PROMPT_VERSION` already marks the boundary between
 * corrections that could carry this paragraph and those that never would.
 */
export function earlyClosingInstruction(earlyClosingCount: number): string {
  // `Number.isFinite` first, as `technicalIncidentInstruction` does: `<= 0`
  // is false for NaN, so a count that arrived unparsed would print an
  // examiner fault into the prompt of a sitting that never had one. The
  // finish route validates before either function is reached (see
  // `finishPayloadSchema`); the two incident paragraphs still guard alike,
  // so neither is the one a future caller finds out about the hard way.
  if (!Number.isFinite(earlyClosingCount) || earlyClosingCount <= 0) return "";

  return `INCIDENT PENDANT LE DEBAT : l'examinateur a annoncé À TORT la fin de l'épreuve avant la fin du temps imparti (en prenant congé, en invitant le candidat à quitter la salle, ou en annonçant une partie qui n'existe pas). Cette clôture prématurée est une DÉFAILLANCE DE L'EXAMINATEUR, pas un fait de la prestation du candidat. Elle apparaît dans la transcription, et elle est audible dans l'enregistrement si vous en disposez. N'en tenez aucun compte : ne traitez pas ces tours de parole comme la fin réelle de l'épreuve, et ne pénalisez le candidat sur AUCUN critère si l'échange s'en trouve écourté ou si sa participation s'arrête après cette annonce — un candidat à qui l'on dit que l'épreuve est terminée cesse légitimement de parler.`;
}
