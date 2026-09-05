/**
 * What the corrector is told when the app itself broke during the épreuve
 * (#189) — the sitting-specific half of the « INCIDENT TECHNIQUE » case that
 * `delf/production-cases.ts` states as a general rule.
 *
 * The general rule tells the corrector not to charge a technical silence to the
 * candidate. This paragraph is what lets it know there WAS one. Without it the
 * instruction is unusable: a transcript in which the examiner asks a question,
 * nothing answers it, and the exchange resumes two minutes later on another
 * subject reads exactly like a candidate who would not answer — and the model
 * has no way to tell that apart from the record it is handed.
 *
 * **What counts as evidence, and what does not.** The reconnect count is the
 * app's own, incremented by `ExamController` when a Live socket dies and a new
 * one is opened mid-épreuve. It is a fact about the connection, not a claim
 * about the candidate, and each reconnect is a window during which the examiner
 * was mute and the candidate's speech was not being transcribed — #133 recorded
 * the sharper version of it, a fresh session that came back not knowing the
 * débat had begun.
 *
 * **What it deliberately does NOT do: excuse a penalty.** The duration rule is
 * measured from the recording, and the recording is the browser's own file: it
 * keeps running through a dropped socket, so a reconnect shortens the
 * transcript and never the measured seconds. There is therefore nothing for the
 * rubric to waive here, and inventing a waiver would hand a mark-changing lever
 * to a number the client reports about itself. Contrast #92, where the waiver
 * is the point — an examiner who dismisses the candidate really does shorten
 * the audio. This paragraph changes what the corrector believes about the
 * transcript, and nothing else.
 *
 * Its own module, away from `evaluate.ts`, like `phonology-instruction.ts`:
 * that file imports `server-only` and the unit suite cannot load it, and a
 * paragraph that decides whether a silence is charged is one to assert.
 */

/**
 * The incident paragraph, or nothing.
 *
 * Empty at zero rather than a reassuring "the connection held" line, for
 * `earlyClosingInstruction`'s reason: an ordinary sitting's prompt should not
 * change shape for a fault it did not have.
 *
 * The count is stated rather than rounded to "the session dropped" because one
 * drop and six are different readings of the same transcript — six is a sitting
 * whose exchange should barely be trusted to show interaction at all.
 */
export function technicalIncidentInstruction(reconnectCount: number): string {
  if (!Number.isFinite(reconnectCount) || reconnectCount <= 0) return "";

  const times = reconnectCount === 1 ? "une fois" : `${reconnectCount} fois`;

  return `INCIDENT TECHNIQUE PENDANT L'ÉPREUVE : la connexion avec l'examinateur a été interrompue ${times} et rétablie. Pendant ces interruptions, le candidat n'entendait plus l'examinateur et ses paroles n'étaient pas transcrites. Le transcript peut donc comporter des blancs, une question restée sans réponse, une reprise abrupte ou un passage manquant qui ne sont PAS le fait du candidat. Ne les traitez pas comme un refus de répondre, un abandon de l'échange ni une rupture de la continuité du discours, et ne pénalisez le candidat sur AUCUN critère à cause d'eux : notez uniquement ce qu'il a effectivement produit ailleurs dans l'épreuve.`;
}
