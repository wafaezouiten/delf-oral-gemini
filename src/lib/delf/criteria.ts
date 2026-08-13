/**
 * DELF Production Orale — the five official criteria, their prose, the 0/1/3/5
 * band scale, and the evaluation rules block.
 *
 * Mirrors the official France Éducation international corrector grid for the
 * production orale (docs/GRILLES_B2_CORRECTION.md · docs/assets/grilles/grille-po-b2.pdf).
 * The /25 competency is broken into **five criteria**, each scored on the
 * discrete **0 / 1 / 3 / 5 band scale**:
 *
 *   Compétence pragmatique & sociolinguistique → realisationTache · interaction
 *   Compétence linguistique                    → lexique · morphosyntaxe · phonologie
 *
 * PORT NOTE: extracted from the reference implementation
 * (`delf-preps@chore/240-remove-unused-series-actions`,
 * `src/lib/prompts/orale/index.ts`). These are the grille's own words:
 * paraphrasing them changes what the model grades, which makes scores
 * incomparable with production. The reproduction audit takes exactly
 * `ORAL_CRITERIA`, `ORAL_CRITERIA_LABELS`, `ORAL_CRITERIA_COMPETENCE`,
 * `ORAL_CRITERIA_DESCRIPTIONS`, `BAND_SCALE` and the evaluation-rules block, and
 * drops the surrounding machinery: `{{slot}}` templating,
 * `ORAL_EVAL_PLACEHOLDERS` and its validation, `oralTaskFamily()`, the per-level
 * expectations, `buildExaminerPrompt()` and `examinerConsigne()`.
 *
 * Two deliberate, audit-mandated departures inside the copied text:
 *
 *  - `BAND_SCALE` was module-private in the reference; it is exported here
 *    because the prompt builder that consumed it is not being ported.
 *  - `EVALUATION_RULES` omits the reference's "PHONOLOGIE À PARTIR D'UN TEXTE"
 *    bullet — the audit's one deliberate break. That wording tells the model to
 *    infer fluency from filler counts *because the incumbent's corrector has no
 *    audio*; porting it into a project whose justification is real audio would
 *    discard the reason the project exists. The criterion, its weight, its bands
 *    and its label all survive unchanged; only the evidence it reasons from is
 *    replaced, and that replacement belongs to the evaluation phase, not here.
 *    The `{{level}}` slot in the "adaptez vos attentes" rule is resolved to B2
 *    for the same reason the templating is dropped: this project is B2-only.
 */

import { GRILLE_BANDS } from "./grille";

// The five DELF oral criteria, each a 0/1/3/5 band → /25 total.
export const ORAL_CRITERIA = [
  "realisationTache",
  "interaction",
  "lexique",
  "morphosyntaxe",
  "phonologie",
] as const;

export type OralCriterion = (typeof ORAL_CRITERIA)[number];

/** Human labels for the five criteria (results UI). */
export const ORAL_CRITERIA_LABELS: Record<OralCriterion, string> = {
  realisationTache: "Réalisation de la tâche",
  interaction: "Interaction",
  lexique: "Lexique",
  morphosyntaxe: "Morphosyntaxe",
  phonologie: "Maîtrise phonologique",
};

/** Which competence each criterion belongs to (grille grouping, results UI). */
export const ORAL_CRITERIA_COMPETENCE: Record<OralCriterion, string> = {
  realisationTache: "Compétence pragmatique & sociolinguistique",
  interaction: "Compétence pragmatique & sociolinguistique",
  lexique: "Compétence linguistique",
  morphosyntaxe: "Compétence linguistique",
  phonologie: "Compétence linguistique",
};

/** What each criterion measures — shown in the report and given to the model. */
export const ORAL_CRITERIA_DESCRIPTIONS: Record<OralCriterion, string> = {
  realisationTache:
    "La tâche est réalisée : prise de position claire, propos structuré, arguments et exemples pertinents, registre adapté à la situation.",
  interaction:
    "Le candidat gère l'échange : il réagit aux relances et aux objections, négocie le sens, relance et maintient la conversation avec aisance.",
  lexique:
    "Le vocabulaire est étendu et précis sur les deux parties de l'épreuve, avec peu de lacunes ou de répétitions.",
  morphosyntaxe:
    "La morphosyntaxe est contrôlée : structures variées, temps et modes, accords ; les erreurs ne gênent pas la compréhension.",
  phonologie:
    "La prononciation, l'intonation et le rythme sont clairs et naturels ; l'écoute ne demande pas d'effort à l'interlocuteur.",
};

/**
 * The 0/1/3/5 band scale, described once and injected into every prompt. The
 * "n'utilisez JAMAIS 2 ni 4" instruction is load-bearing: it is what keeps the
 * model on the legal bands, and `snapToBand` is the net underneath it.
 */
export const BAND_SCALE = `ÉCHELLE DE NOTATION : chaque critère reçoit EXACTEMENT l'une de ces quatre notes : ${GRILLE_BANDS.join(
  " · ",
)}. N'utilisez JAMAIS 2 ni 4.
- 0 = Non répondu ou production insuffisante (rien d'évaluable pour ce critère).
- 1 = En dessous du niveau ciblé (tentative présente mais clairement sous le niveau B2).
- 3 = Au niveau ciblé B2 (le critère est satisfait au niveau attendu).
- 5 = Au niveau ciblé supérieur B2+ (solidement B2, proche du C1).`;

/**
 * The evaluation rules block, injected verbatim into the corrector prompt.
 *
 * Only `CANDIDAT:` lines are graded; the examiner's vocabulary is never graded;
 * the manner is judged, never the opinion; and nothing evaluable means zero
 * everywhere rather than a charitable guess. See the port note above for the one
 * omitted bullet.
 */
export const EVALUATION_RULES = `RÈGLES D'ÉVALUATION (PRIORITÉ ABSOLUE) :
- Seules les répliques préfixées « CANDIDAT: » sont notées. Les répliques « EXAMINATEUR: » servent uniquement de contexte ; ne notez JAMAIS le vocabulaire, les idées ou les structures de l'examinateur.
- Évaluez la MANIÈRE de s'exprimer, JAMAIS l'opinion défendue : ne récompensez ni ne pénalisez le point de vue du candidat, seulement la qualité linguistique et rhétorique de sa prestation.
- Lorsque l'examinateur conteste la position du candidat (au débat, ou ponctuellement lors de l'expression d'un point de vue), le critère « interaction » valorise la capacité à réagir spontanément, à défendre et nuancer sa position sous la contradiction et à apporter de NOUVEAUX exemples ; l'abandon de sa position sans la défendre est un signe de faiblesse à ce critère.
- Adaptez vos attentes au niveau B2 : n'exigez pas d'argumentation complexe à un niveau A, exigez-la à B2.
- CAS LIMITE : si aucune réplique « CANDIDAT: » ne contient de contenu évaluable, mettez 0 à TOUS les critères.
- total25 est EXACTEMENT la somme des cinq notes de critères (0 à 25). Ne le calculez pas autrement.
- Chaque justification doit être concrète et FONDÉE SUR LA TRANSCRIPTION : citez une réplique ou une tournure du candidat, nommez la bande atteinte (en dessous / B2 / B2+) et dites pourquoi.
- Restez bienveillant mais rigoureux. Les points forts portent uniquement sur ce que le candidat a réellement produit.`;
