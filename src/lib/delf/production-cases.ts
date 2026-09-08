/**
 * What the corrector is told to do with a prestation that is not a whole one
 * (#189) — the twelve cases a real DELF jury meets and a corrector reading a
 * transcript for the first time has no policy for.
 *
 * It exists because the grille answers "how good was this" and says nothing
 * about "there was hardly any of it". Left to itself the corrector improvises,
 * and it improvises in two opposite directions on the same sitting: a débat of
 * four « oui, vous avez raison » answers came back scored 3 across all five
 * criteria — the language criteria credited from eleven words — while a
 * candidate whose grammar was conspicuously broken but whose position was
 * argued and defended was given 0 on morphosyntaxe, a band the scale reserves
 * for a production too thin to evaluate at all.
 *
 * Its own module, pure and asserted, for the reason `evaluation-prompt.ts` is
 * one: these are the words that decide a candidate's marks, and #189 lists the
 * cases explicitly enough that a test can hold the prompt to each of them.
 *
 * **What it must never contain: arithmetic.** The duration tiers, the halving,
 * the phonologie ceiling and the competency floor are all `orale-rubric.ts`'s,
 * computed from what the model returns (#9). This block therefore never says
 * how long a part should have run or what a short one costs — it says how to
 * READ a thin performance, which is the half the rubric cannot do. The one
 * sentence that mentions duration says the corrector should not grade it,
 * precisely so the clock is not charged twice: once here in a band and once in
 * the rubric.
 *
 * **Generic by construction.** Nothing here names a sujet, a question or an
 * expected answer, and nothing may: the same block is rendered for every B2
 * document in `topics.ts` and for any added later.
 */

/**
 * The block, injected into every corrector prompt, in the rules section.
 *
 * Ordered as #189 orders the cases — the débat's participation first, then the
 * language criteria, then the two failures that are the app's rather than the
 * candidate's — because that is the order in which a corrector meets them
 * reading a transcript from the top.
 *
 * Two boundaries are restated inside it rather than left to the stage contract
 * above: that « realisationTache » is the monologue's and « interaction » the
 * débat's. The cases are exactly where a corrector reaches for the wrong one —
 * a candidate who abandons their thesis under contradiction is an interaction
 * weakness, not a badly built exposé — and the contract's general statement of
 * it is three blocks away from the case that needs it.
 *
 * And one boundary is drawn against another block of the same prompt.
 * `EVALUATION_RULES` ends « CAS LIMITE : si aucune réplique CANDIDAT ne
 * contient de contenu évaluable, mettez 0 à TOUS les critères », which is right
 * about a sitting and catastrophic about a PART: a candidate with a real if
 * thin exposé and four monosyllables of débat satisfies it on a quick reading,
 * and comes back 0 on lexique and morphosyntaxe for a monologue the corrector
 * did in fact have. That is the automatic zero #189 forbids twice over, so the
 * silence case here says which of the two it is and hands the single empty part
 * back to the first case.
 */
export const PRODUCTION_CASES = `PRESTATIONS PARTIELLES, BRÈVES OU INTERROMPUES (PRIORITÉ ABSOLUE) :
Notez EXCLUSIVEMENT ce que le candidat a réellement produit. N'inventez jamais un contenu absent, ne complétez pas une réponse inachevée, et ne supposez pas ce qu'il aurait dit. Une prestation partielle se note ; elle ne se devine pas.
- AUCUNE RÉPONSE AU DÉBAT : si le candidat ne répond à aucune question de l'examinateur, « interaction » est très basse, et 0 s'il n'a rien produit du tout dans cette partie. Les critères de langue se notent alors sur le seul monologue, et « realisationTache » garde la note que l'exposé mérite.
- LE CANDIDAT COMMENCE PUIS SE TAIT : notez ce qui a été produit avant le silence, sans rien extrapoler de ce qui suit.
- UNE SEULE RÉPONSE TRÈS BRÈVE : évaluez cette réponse pour ce qu'elle vaut réellement, sur tous les critères qu'elle permet d'observer ; l'interaction, elle, reste très limitée.
- PLUSIEURS RÉPONSES TRÈS BRÈVES : « interaction » est basse, car l'échange n'est ni développé ni maintenu. Mais si ces réponses démontrent un lexique précis, des structures contrôlées ou une prononciation claire, ces critères-là conservent les points correspondants : une prestation courte n'est pas une prestation faible sur tous les plans.
- LE CANDIDAT RÉPOND SANS DÉFENDRE SA POSITION : c'est une faiblesse de « interaction » (il ne réagit pas à l'objection, n'argumente ni sa défense ni son revirement). Un exposé qui, lui, ne dégage ni problématique ni argumentation relève de « realisationTache ».
- LE CANDIDAT RÉPOND À CÔTÉ : une réponse hors sujet ou sans rapport avec la question posée ne réalise pas la tâche demandée. Baissez le critère de la partie concernée (« interaction » pour une réponse au débat, « realisationTache » pour un exposé hors sujet), sans rien retirer aux critères de langue pour autant.
- LE CANDIDAT HÉSITE BEAUCOUP MAIS FINIT PAR RÉPONDRE : ne pénalisez pas lourdement de façon automatique. Les hésitations, faux départs et reprises relèvent de la fluidité, donc de « phonologie » ; elles ne se comptent pas une seconde fois contre « interaction » ou « lexique » dès lors que la réponse arrive et qu'elle répond.
- BEAUCOUP D'ERREURS DE GRAMMAIRE MAIS LE MESSAGE PASSE : notez « morphosyntaxe » pour ce qu'elle est, le plus souvent 1 (en dessous du niveau ciblé). Ne mettez JAMAIS 0 automatiquement : 0 est réservé à une production trop pauvre pour être évaluée, pas à une production fautive que l'on comprend.
- PRONONCIATION DÉFECTUEUSE MAIS CANDIDAT COMPRÉHENSIBLE : « phonologie » se note sur l'INTELLIGIBILITÉ effective. Un accent marqué, des sons mal réalisés ou une prosodie approximative qui n'empêchent pas de comprendre ne valent pas 0 ; ce qui compte est l'effort que l'écoute demande.
- SILENCE COMPLET SUR TOUTE L'ÉPREUVE : si aucune réplique du candidat, dans AUCUNE des deux parties, ne contient de contenu évaluable, une note très basse ou nulle sur tous les critères est la réponse juste. Ce cas est le seul qui autorise 0 partout : une seule partie vide ne le déclenche PAS, elle relève du premier cas ci-dessus, et les critères de langue restent notés sur la partie qui, elle, a eu lieu.
- INCIDENT TECHNIQUE : un silence, une réponse manquante ou une question restée sans réponse dont la cause est un incident technique (microphone, connexion, session interrompue) n'est JAMAIS imputable au candidat. Ne le pénalisez sur aucun critère.
- DÉFAUT DE TRANSCRIPTION : l'absence d'un passage dans le transcript ne prouve pas que le candidat n'a rien dit. Si vous disposez de l'enregistrement, c'est lui qui fait foi ; sinon, ne transformez pas une lacune du texte en silence du candidat.
- LA DURÉE NE SE NOTE PAS EN ELLE-MÊME : n'attribuez pas une note basse au seul motif qu'une partie a été courte, et ne retirez pas de points pour la durée. Notez la qualité de ce qui a été produit. Une prestation brève qui démontre une réelle maîtrise en garde le crédit ; une prestation longue mais répétitive, hors sujet ou non argumentée est pénalisée sur les critères que cela concerne.`;
