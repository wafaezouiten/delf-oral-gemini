/**
 * DELF Production Orale — the five official criteria, their prose, the 0/1/3/5
 * band scale, and the instruction blocks the corrector is given.
 *
 * Mirrors the official France Éducation international corrector grid for the
 * production orale and its *explicitation* — the examiner-facing commentary on
 * each criterion, which is far more specific than the grid's own headings
 * (docs/GRILLES_B2_CORRECTION.md · docs/assets/grilles/grille-po-b2.pdf ·
 * docs/assets/grilles/explic-grille-po-b2.pdf in the reference repo). The /25
 * competency is broken into **five criteria**, each scored on the discrete
 * **0 / 1 / 3 / 5 band scale**:
 *
 *   Compétence pragmatique & sociolinguistique → realisationTache · interaction
 *   Compétence linguistique                    → lexique · morphosyntaxe · phonologie
 *
 * PORT NOTE (#173). Re-ported from the main project as it stands at
 * `delf-preps@5170f0dd` (2026-08-27), `src/lib/prompts/orale/index.ts`. The
 * first port (#2, 2026-08-13) took that file as it was then; the reference has
 * since adopted the FEI explicitation for the criterion prose AND grown a
 * *two-part sitting* mode — `SITTING_TASK_LABELS`, `SITTING_TASK_DESCRIPTIONS`
 * and `COMPLETE_STAGE_DIRECTIVE` — which is the shape this project has always
 * had. Two blocks invented here (`SCALE_USE` and `TASK_ATTRIBUTION`, both in
 * `gemini/evaluate.ts`) said a weaker version of what the reference now says
 * itself, and are gone: the point of this file is that the corrector reads the
 * grille's words, not ours.
 *
 * These are the reference's own words. Paraphrasing them changes what the model
 * grades, which makes scores incomparable with production.
 *
 * What the port still drops, and why:
 *
 *  - `{{slot}}` templating, `ORAL_EVAL_PLACEHOLDERS` and its validation. Those
 *    exist because the reference's template is an admin-editable database row;
 *    here the prompt is code, reviewed in a diff and stamped with
 *    `EVAL_PROMPT_VERSION`.
 *  - `oralTaskFamily()`, `PART_TYPE_FOCUS`, the « continuité du discours »
 *    adaptation and the A1/A2/B1 expectations. This project is B2-only and every
 *    sitting is the complete two-part épreuve, so `criterionView()`'s branches
 *    all resolve one way and are resolved here rather than carried.
 *  - `MONOLOGUE_STAGE_DIRECTIVE` and the /20 partial stage. There is no partial
 *    correction here: a sitting is graded once, over both parts.
 *  - `EVALUATION_RULES` omits the reference's « PHONOLOGIE À PARTIR D'UN TEXTE »
 *    bullet — the audit's one deliberate break, unchanged since #2. That wording
 *    tells the model to infer fluency from filler counts *because the
 *    incumbent's corrector has no audio*; porting it into a project whose
 *    justification is real audio would discard the reason the project exists.
 *    The criterion, its weight, its bands and its label all survive unchanged;
 *    only the evidence it reasons from is replaced, by
 *    `gemini/phonology-instruction.ts`.
 *
 * One addition that is this project's and is marked as such below:
 * {@link ORAL_CRITERIA_SUMMARIES}. The reference's UI reads only the label and
 * the compétence off its criteria, so its descriptions are free to be written at
 * a corrector (« NE PÉNALISEZ PAS… »). Ours prints a description on the results
 * page, and that sentence has to be addressed to the candidate.
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

/**
 * Human labels for the five criteria (results UI).
 *
 * `phonologie` is the grid's own wording in full. It was shortened to
 * « Maîtrise phonologique » here, which is the kind of drift the reference fixed
 * on its own side and this re-port carries over.
 */
export const ORAL_CRITERIA_LABELS: Record<OralCriterion, string> = {
  realisationTache: "Réalisation de la tâche",
  interaction: "Interaction",
  lexique: "Lexique",
  morphosyntaxe: "Morphosyntaxe",
  phonologie: "Maîtrise du système phonologique",
};

/** Which competence each criterion belongs to (grille grouping, results UI). */
export const ORAL_CRITERIA_COMPETENCE: Record<OralCriterion, string> = {
  realisationTache: "Compétence pragmatique & sociolinguistique",
  interaction: "Compétence pragmatique & sociolinguistique",
  lexique: "Compétence linguistique",
  morphosyntaxe: "Compétence linguistique",
  phonologie: "Compétence linguistique",
};

/**
 * The two pragmatic criteria as the official grid names them on a level sat as
 * ONE épreuve covering both parts — which is every sitting here.
 *
 * The grid has two « réalisation de la tâche » lines, one per part:
 * `realisationTache` marks the exposé and `interaction` marks the débat. Worded
 * exactly as `grille-po-b2.pdf` words them, which is the grid a candidate is
 * marked against on the day. Prompt-side only: the results page keeps the short
 * headings above, which are what fits a criterion row.
 */
export const SITTING_TASK_LABELS: Record<"realisationTache" | "interaction", string> = {
  realisationTache: "Réalisation de la tâche : monologue suivi",
  interaction: "Réalisation de la tâche : exercice en interaction",
};

/**
 * What each criterion measures, **as the corrector is told it** — the FEI
 * explicitation, and for the two pragmatic criteria the reference's two-part
 * sitting wording, which pins each of them to its own half of the épreuve.
 *
 * Prompt text. Long, imperative and addressed to a corrector; the results page
 * reads {@link ORAL_CRITERIA_SUMMARIES} instead.
 */
export const ORAL_CRITERIA_DESCRIPTIONS: Record<OralCriterion, string> = {
  // The explicitation is explicit that a formal introduction is NOT required:
  // « On n'attendra pas nécessairement une introduction avec présentation du
  // document déclencheur et annonce du plan, même si cela est souvent conseillé
  // aux candidats. » What IS required is dégager une problématique and go beyond
  // merely presenting the theme. Listing the intro as part of the criterion was
  // marking a candidate down for skipping a step FEI does not ask for.
  realisationTache:
    "PARTIE 1 (monologue suivi) uniquement : le candidat va au-delà de la présentation du thème et dégage clairement une problématique à partir du document, puis défend un point de vue appuyé sur des arguments développés et des exemples pertinents, nuancés (par la concession par exemple), dans une organisation logique et facilitante. N'EXIGEZ PAS une introduction formelle avec présentation du document et annonce du plan : elle est souvent conseillée en cours de préparation mais n'est pas attendue, et son absence ne se pénalise pas. N'évaluez ici QUE l'exposé, jamais le débat.",
  // « défendre sa position (ou faire des concessions, rectifier…) » — the
  // parenthesis is FEI's. A candidate who concedes with an argument is doing one
  // of the things the criterion asks for; only unargued capitulation is a
  // weakness, which is the distinction this wording has to carry.
  interaction:
    "PARTIE 2 (débat) uniquement : le candidat précise et nuance ses propos à partir des questions de l'examinateur qui le conteste. Il réagit de manière pertinente aux objections pour défendre sa position, OU pour concéder et rectifier : une concession argumentée est une réaction attendue au niveau B2, seul l'abandon pur et simple de sa thèse, sans la défendre ni justifier le revirement, est une faiblesse. Valorisez l'apport de NOUVEAUX exemples et le maintien de l'échange avec aisance. N'évaluez ici QUE le débat, jamais l'exposé.",
  lexique:
    "Le répertoire lexical correspond à la situation proposée et au niveau évalué. Au niveau B2, le vocabulaire doit être suffisamment précis et varié, et le candidat doit savoir employer des périphrases. En revanche, NE PÉNALISEZ PAS les répétitions des mots-clés induits par le sujet de l'exposé. La communication ne doit pas être entravée ; les éventuelles lacunes et confusions se produisent surtout lorsqu'il s'agit d'exprimer des idées complexes.",
  morphosyntaxe:
    "Les structures et les formes grammaticales correspondent au niveau évalué : contrôlez la structure de la phrase simple et des phrases complexes. Le candidat doit savoir utiliser des structures variées pour nuancer et préciser sa pensée. Les erreurs ne doivent pas être systématiques, et le candidat doit être capable de S'AUTOCORRIGER, notamment sur les structures censées être acquises aux niveaux antérieurs : une autocorrection réussie est un signe de contrôle, à porter au crédit du candidat sur ce critère.",
  phonologie:
    "La prononciation est claire et les erreurs ponctuelles n'affectent pas la compréhension du message. Le niveau B2 se caractérise par une certaine aisance, y compris dans des énoncés assez longs et complexes. L'examinateur ne devrait plus avoir d'efforts à fournir pour comprendre le candidat.",
};

/**
 * The same five criteria said to the CANDIDATE — this project's, not the
 * reference's, and the one block in this file that is deliberately not the
 * grille's own words.
 *
 * The results page prints a sentence under each criterion row. The explicitation
 * above cannot be that sentence: it is an instruction to a corrector, and a
 * candidate reading « NE PÉNALISEZ PAS les répétitions » is being handed the
 * marking scheme's imperative mood as if it were advice. These are the
 * descriptions that page has always shown, kept verbatim across the re-port so
 * the UI does not move under a prompt change.
 */
export const ORAL_CRITERIA_SUMMARIES: Record<OralCriterion, string> = {
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

// The compétence tag as it appears in parentheses in the prompt's numbered list:
// the bare grouping, where ORAL_CRITERIA_COMPETENCE spells out the heading the
// results UI prints above the bands.
const CRITERION_PROMPT_TAG: Record<OralCriterion, string> = {
  realisationTache: "pragmatique & sociolinguistique",
  interaction: "pragmatique & sociolinguistique",
  lexique: "linguistique",
  morphosyntaxe: "linguistique",
  phonologie: "linguistique",
};

/** How the prompt names a criterion: the grid's two-part wording where it has one. */
export function promptCriterionLabel(criterion: OralCriterion): string {
  return criterion === "realisationTache" || criterion === "interaction"
    ? SITTING_TASK_LABELS[criterion]
    : ORAL_CRITERIA_LABELS[criterion];
}

/**
 * The numbered criteria block injected into the corrector's prompt. Each line is
 * « N. <schemaKey> - <Name> (<tag>) : <desc> » — the `<schemaKey>` prefix maps
 * the prose criterion onto its output-schema field, which is what stops a model
 * returning a carefully argued band under the wrong key.
 */
export function renderOralCriteriaList(): string {
  return ORAL_CRITERIA.map(
    (key, index) =>
      `${index + 1}. ${key} - ${promptCriterionLabel(key)} (${CRITERION_PROMPT_TAG[key]}) : ${ORAL_CRITERIA_DESCRIPTIONS[key]}`,
  ).join("\n");
}

/**
 * The attendus for the level being graded. The reference keys this by level;
 * this project is B2-only, so its B2 row is resolved here.
 */
export const B2_EXPECTATION =
  "Niveau B2 (utilisateur indépendant, avancé) : le candidat peut développer un point de vue argumenté, nuancer, défendre sa position dans un débat, réagir avec aisance et spontanéité. On attend une argumentation construite, des connecteurs variés et une bonne interaction.";

/**
 * What the épreuve is, and where each criterion's evidence lives. The
 * reference's `SITTING_FOCUS`, which overrides its per-part focus blocks
 * entirely on a two-part level.
 */
export const SITTING_FOCUS =
  "Tâche : épreuve complète en deux parties sur le même document. La partie 1 est un monologue suivi (le candidat expose seul) et la partie 2 un débat (l'examinateur conteste sa position). Les deux critères pragmatiques sont donc « réalisation de la tâche 1 » pour l'exposé et « réalisation de la tâche 2 » pour le débat : chacun ne porte QUE sur sa partie. Les critères de langue (lexique, morphosyntaxe, phonologie) portent sur les DEUX parties réunies.";

/**
 * The 0/1/3/5 band scale, described once and injected into every prompt.
 *
 * The « n'utilisez JAMAIS 2 ni 4 » instruction is load-bearing: it is what keeps
 * the model on the legal bands, and `snapToBand` is the net underneath it. The
 * closing paragraph is the reference's own use-the-whole-scale instruction — it
 * replaces a shorter `SCALE_USE` block written here, which existed for a
 * measured reason (docs/EVALUATION_FINDINGS.md: without one, the corrector puts
 * 3 on everything) and said less than this one does.
 */
export const BAND_SCALE = `ÉCHELLE DE NOTATION : chaque critère reçoit EXACTEMENT l'une de ces quatre notes : ${GRILLE_BANDS.join(
  " · ",
)}. N'utilisez JAMAIS 2 ni 4.
- 0 = Non répondu ou production insuffisante : la production n'est pas assez longue pour être évaluée, se situe très en-deçà du niveau ciblé (au moins deux niveaux) ou présente une ou plusieurs anomalies.
- 1 = En dessous du niveau ciblé : le niveau de la production est inférieur au niveau visé et correspond davantage au niveau B1 qu'au niveau B2.
- 3 = Au niveau ciblé : la production satisfait les prérequis MINIMAUX du niveau B2, mais ne permet pas de confirmer une maîtrise robuste ou approfondie de ce même niveau.
- 5 = Au niveau ciblé + : la production démontre une maîtrise robuste ou approfondie du niveau B2. Une production qui démontrerait une maîtrise encore supérieure (C1 ou plus) reçoit ÉGALEMENT 5 ; n'attendez PAS un niveau C1 pour l'accorder.

UTILISEZ TOUTE L'ÉCHELLE : n'attribuez pas 3 par défaut. Un critère réellement réussi reçoit 5, un critère faible reçoit 1, un critère absent reçoit 0. Deux prestations de qualité différente DOIVENT recevoir des notes différentes : votre notation doit refléter l'écart réel entre une bonne et une mauvaise production, sans se tasser au milieu. Des erreurs occasionnelles qui ne gênent pas la communication sont attendues au niveau B2 et restent compatibles avec un 5 ; réservez le 3 aux prestations qui atteignent B2 avec des limites nettes ou récurrentes. Une prestation excellente sur tous les critères doit pouvoir approcher 25/25.`;

/** The reference's house style for everything the candidate will read back. */
export const STYLE_RULE = `STYLE D'ÉCRITURE : dans tout texte destiné au candidat (commentaires et justifications), n'utilisez jamais de tiret cadratin — ni de tiret demi-cadratin – ; préférez la virgule, les deux-points ou les parenthèses.`;

/**
 * The evaluation rules block, injected verbatim into the corrector prompt.
 *
 * Only `CANDIDAT:` lines are graded; the examiner's vocabulary is never graded;
 * the manner is judged, never the opinion; a poorly questioned candidate is not
 * charged for the exchange they were never given; a self-correction reads as
 * control on morphosyntaxe and as a hached delivery on phonologie but never
 * twice against the candidate; and nothing evaluable means zero everywhere
 * rather than a charitable guess. See the port note above for the one omitted
 * bullet.
 */
export const EVALUATION_RULES = `RÈGLES D'ÉVALUATION (PRIORITÉ ABSOLUE) :
- Seules les répliques préfixées « CANDIDAT: » sont notées. Les répliques « EXAMINATEUR: » servent uniquement de contexte ; ne notez JAMAIS le vocabulaire, les idées ou les structures de l'examinateur.
- Évaluez la MANIÈRE de s'exprimer, JAMAIS l'opinion défendue : ne récompensez ni ne pénalisez le point de vue du candidat, seulement la qualité linguistique et rhétorique de sa prestation.
- Lorsque l'examinateur conteste la position du candidat (au débat, ou ponctuellement lors de l'expression d'un point de vue), le critère « interaction » valorise la capacité à réagir spontanément, à préciser et nuancer sa position sous la contradiction et à apporter de NOUVEAUX exemples. Défendre sa position et concéder ou rectifier sont DEUX réactions valides à ce niveau : une concession argumentée se valorise autant qu'une défense. Seul l'abandon pur et simple de sa thèse, sans la défendre ni justifier le revirement, est un signe de faiblesse.
- ÉQUITÉ ENVERS LE CANDIDAT : la performance en interaction dépend en grande partie de la qualité des relances de l'examinateur. Si l'examinateur a peu questionné, a posé des questions faibles ou n'a pas contredit le candidat, ne pénalisez PAS le candidat pour un échange qu'il n'a pas eu l'occasion de mener : notez ce qu'il a fait des relances reçues.
- AUTOCORRECTIONS : elles se lisent différemment selon le critère. En « morphosyntaxe », une autocorrection réussie est un signe de contrôle, à porter au CRÉDIT du candidat. En « phonologie », des autocorrections nombreuses restent un indice de débit haché. Ne comptez donc pas la même autocorrection deux fois contre le candidat.
- Adaptez vos attentes au niveau B2 : n'exigez pas d'argumentation complexe à un niveau A, exigez-la à B2.
- CAS LIMITE : si aucune réplique « CANDIDAT: » ne contient de contenu évaluable, mettez 0 à TOUS les critères.
- total25 est EXACTEMENT la somme des cinq notes de critères (0 à 25). Ne le calculez pas autrement.
- Chaque justification doit être concrète et FONDÉE SUR LA TRANSCRIPTION : citez une réplique ou une tournure du candidat, nommez la bande atteinte (en dessous / B2 / B2+) et dites pourquoi.
- Restez bienveillant mais rigoureux. Les points forts portent uniquement sur ce que le candidat a réellement produit.`;

/**
 * The non-negotiable sitting contract, appended AFTER everything else.
 *
 * The reference appends it after its admin-editable template so no stored
 * template version can edit the criteria set away. Here the prompt is code and
 * nobody can edit it away, but the position is kept for the other reason it
 * works: this is the paragraph that has to win, and it is last.
 *
 * Note what it does NOT contain: any arithmetic. The sum, the duration penalty
 * and the competency floor are computed from what the model returns, by
 * `orale-rubric.ts`. A prompt that told the model to subtract three points for a
 * short épreuve would be a second implementation of the rubric, written in
 * French, unversioned and untestable (#9).
 */
export const COMPLETE_STAGE_DIRECTIVE = `CONTRAINTE DE CORRECTION COMPLÈTE (PRIORITAIRE SUR TOUTE CONSIGNE CI-DESSUS) :
La transcription couvre les DEUX parties de l'épreuve. Notez les cinq critères sur 25 points au total.
- « realisationTache » évalue UNIQUEMENT la partie 1 (le monologue suivi) : prise de position, structure de l'exposé, arguments et exemples.
- « interaction » évalue UNIQUEMENT la partie 2 (le débat) : réaction aux objections, défense et nuance de la position sous la contradiction, apport de NOUVEAUX exemples, maintien de l'échange.
- « lexique », « morphosyntaxe » et « phonologie » évaluent les DEUX parties ensemble, conformément à la grille officielle.
- Si le candidat abandonne sa position dès la première objection SANS la défendre ni justifier son revirement, c'est une faiblesse du critère « interaction », pas de « realisationTache ». En revanche, concéder un point en l'argumentant ou rectifier son propos est une réaction attendue au niveau B2 : valorisez-la.
- La qualité du débat dépend aussi des relances de l'examinateur. Si celui-ci a peu ou mal questionné, ne pénalisez pas le candidat pour un échange qu'il n'a pas pu mener.`;
