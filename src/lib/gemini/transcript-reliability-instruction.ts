/**
 * What the corrector is told the transcript is worth (#186).
 *
 * The transcript is Gemini Live's own input transcription: automatic, streamed
 * in fragments while the candidate speaks, never reviewed. It mis-hears words,
 * and it can do worse. On one sitting it rendered a whole débat answer in
 * Portuguese — the candidate had answered in French, and what was stored was a
 * Portuguese paraphrase of it — and a reconnect's replayed audio made another
 * answer arrive twice, word for word. The corrector, handed the text as if it
 * were a court record, cited « un passage impromptu en langue portugaise »
 * against the lexique band, repeated the charge in the axes prioritaires and
 * the appréciation globale, and read the doubled answer as the candidate
 * repeating themself.
 *
 * In audio mode it had the recording the whole time. The phonologie paragraph
 * told it to listen — for phonologie. Nothing told it the text could be wrong,
 * or which of the two to believe when they disagree, so it believed the text.
 * This paragraph says the audio outranks the transcript for EVERY criterion,
 * and names the three artefacts worth checking before they are charged.
 *
 * Text mode has no audio to check against, so it gets the honest version of
 * the same rule: those three shapes are far likelier to be the transcriber's
 * than a B2 candidate's, and the benefit of the doubt goes to the candidate.
 * It keeps the corrector on what a transcript does show reliably — the
 * recurring, coherent errors of grammar and vocabulary — which is what the
 * lexique and morphosyntaxe bands were always graded on.
 *
 * Its own module, like `phonology-instruction.ts` and for the same reason:
 * `evaluate.ts` imports `server-only` and the unit suite cannot load it, and a
 * paragraph that decides what evidence a band may rest on is one to assert.
 */

import type { EvaluationMode } from "@/lib/db/schema";

const TRANSCRIPT_IS_AUTOMATIC =
  "TRANSCRIPTION : le transcript ci-dessus est une transcription AUTOMATIQUE en temps réel (reconnaissance vocale), ni relue ni corrigée. Elle peut contenir des erreurs qui ne sont pas le fait du candidat : mots mal reconnus, passage entier rendu dans une autre langue que celle réellement parlée, phrase ou tour de parole dupliqué mot pour mot, ponctuation et découpage arbitraires.";

const AUDIO_INSTRUCTION = `${TRANSCRIPT_IS_AUTOMATIC} En cas de divergence entre le texte et le son, C'EST L'AUDIO QUI FAIT FOI, pour TOUS les critères et pas seulement la phonologie. Avant de reprocher au candidat un passage dans une langue étrangère, une répétition mot pour mot ou un mot sans rapport avec le contexte, vérifiez-le dans l'enregistrement : si vous ne l'y entendez pas, c'est une erreur de transcription, elle ne pèse sur aucune note et ne figure dans aucune justification.`;

const TEXT_INSTRUCTION = `${TRANSCRIPT_IS_AUTOMATIC} Vous n'avez pas le son pour la vérifier. Un passage entier rendu dans une autre langue que le français, un tour de parole répété mot pour mot ou un mot sans aucun rapport avec le contexte sont selon toute vraisemblance des erreurs de transcription et non des faits de la prestation : ne les comptez pas contre le candidat et ne les citez pas dans les justifications. Jugez le lexique et la morphosyntaxe sur les erreurs cohérentes et récurrentes du texte.`;

export function transcriptReliabilityInstruction(mode: EvaluationMode): string {
  return mode === "audio" ? AUDIO_INSTRUCTION : TEXT_INSTRUCTION;
}
