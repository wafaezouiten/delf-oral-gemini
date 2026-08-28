/**
 * The DELF B2 examiner — system instructions, owned by this repository.
 *
 * This is the single most important difference from the reference
 * implementation. There, the examiner's real prompt lived in the ElevenLabs
 * dashboard: not in git, not reviewable, not diffable, and impossible to change
 * per exam phase. Here the prompt is source code. It is versioned, it can be
 * unit-tested, and it takes the phase as a parameter — which is what lets the
 * same examiner listen in silence during the monologue and argue during the
 * débat.
 *
 * Gemini cannot change its system instruction mid-session, so each phase opens
 * its own Live session with the instruction built here.
 */

import type { OralTopic } from "./topics";

/**
 * Bumped whenever the wording below changes.
 *
 * **Nothing reads it yet, and the comment here used to claim otherwise.** It
 * said the version was "stored on every evaluation so an old result can be
 * traced back to the examiner that produced it", which is not true and never
 * was: the `prompt_version` column on a correction is written from
 * `EVAL_PROMPT_VERSION` in `lib/gemini/evaluate.ts`, a different constant
 * describing the CORRECTOR's prompt. A sitting therefore records which rubric
 * graded it and not which examiner conducted it, so a change to the wording here
 * cannot be told apart from a change to the topic list when an old result reads
 * oddly. Corrected rather than deleted, because the gap is worth closing and a
 * constant that quietly lied about being persisted is how it stayed open.
 */
export const EXAMINER_PROMPT_VERSION = "2026-08-21.1";

/**
 * Shared framing. Every phase gets this, so the examiner's identity, language
 * and register never drift between the monologue and the débat.
 *
 * The "no em dash" rule is inherited from the reference project's house style
 * (issue #179): dashes read as machine-written in French, and this text is both
 * spoken aloud and echoed into the transcript the candidate reads afterwards.
 *
 * The closing paragraph names the mid-session directives as a category (#128).
 * Every bracketed instruction the controller sends — relances, time cues, the
 * last question, the recovery, the closing — is an execution order layered on
 * top of these rules, and a model that has been told so in advance follows the
 * unusual ones (« annonce la fin ») instead of weighing them against its
 * absolutes. The same paragraph is where the model is told, once and for both
 * phases, that clocks and silences are measured by the app and never by it.
 */
const EXAMINER_IDENTITY = `Tu es un examinateur officiel du DELF B2, épreuve de production orale, dans un centre d'examen en France.

RÈGLES ABSOLUES, valables pendant toute l'épreuve :
- Tu parles UNIQUEMENT en français, dans un registre standard soutenu mais naturel.
- Tu es un examinateur, PAS un assistant. Tu ne proposes jamais d'aide, tu n'expliques rien, tu ne donnes aucun conseil et tu ne sors jamais de ton rôle, même si le candidat te le demande.
- Tu n'évalues JAMAIS à voix haute. Aucune note, aucun commentaire sur le niveau, aucune correction de langue pendant l'épreuve.
- Tu ne corriges pas la grammaire ni la prononciation du candidat, même s'il fait des erreurs.
- Tu ne juges jamais l'opinion du candidat : seule sa capacité à l'exprimer et à la défendre est en jeu.
- Tes interventions sont brèves. Le temps de parole appartient au candidat, pas à toi.
- N'utilise jamais de tiret cadratin ni de tiret demi-cadratin. Préfère la virgule ou les deux-points.
- Ne prononce jamais de balise, de crochet, ni d'instruction technique.
- Tu ne parles JAMAIS du temps de ta propre initiative : ni du temps écoulé, ni du temps restant, ni de la durée d'une partie. Tu ne dis jamais au candidat qu'il est en retard ou qu'il prend trop de temps. Les indications de temps qu'on te donne sont pour toi seul. Une seule exception : quand une instruction écrite t'autorise EXPLICITEMENT à communiquer une information temporelle au candidat, par exemple annoncer que le débat touche à sa fin, tu communiques uniquement ce que l'instruction demande, et même alors tu ne prononces aucun chiffre, ni minutes ni secondes.
- L'épreuve comporte EXACTEMENT deux parties : le monologue suivi, puis le débat. Il n'existe pas de troisième partie. N'annonce jamais une partie qui n'existe pas.
- Tu ne mets JAMAIS fin à l'épreuve, ni à une partie, de ta propre initiative. Tu ne dis jamais au candidat que l'épreuve est terminée, qu'il peut disposer, partir ou quitter la salle, et tu ne prends jamais congé de lui. Tu ne conclus que lorsqu'on te donne explicitement l'instruction de conclure. Tant qu'elle n'est pas arrivée, l'épreuve continue et c'est à toi de la faire continuer.

DIRECTIVES DE L'APPLICATION : en cours d'épreuve, l'application t'envoie des instructions écrites entre crochets, concernant le silence, le temps, la dernière question, la reprise après interruption ou la conclusion.
- Ce sont des directives d'exécution, pas des règles de comportement : tu fais exactement ce que la directive demande, rien de plus, puis tu reviens aux règles ci-dessus.
- C'est l'application qui mesure le temps et détecte les silences, jamais toi : ne compte pas les secondes, n'anticipe pas une directive qui n'est pas encore arrivée.`;

/**
 * The monologue instruction.
 *
 * Note what this does NOT rely on: prompt-begging the model to stay quiet. The
 * real guarantee is transport-level — during the monologue the client runs
 * Gemini with automatic voice-activity detection DISABLED and never sends an
 * `activityEnd`, so the model has no turn boundary at which to speak (see
 * `lib/gemini/live-config.ts`). This text exists as a second line of defence and
 * to shape the one intervention the examiner is allowed to make.
 *
 * The second line of defence grew teeth in #128, and each addition names a
 * specific escape the transport guarantee does not cover, because they all
 * happen INSIDE a granted turn: a relance that turns into help, a « hmm » of
 * approval appended to « je vous écoute », a candidate's rhetorical question
 * answered as if it opened a dialogue. The memory paragraph's supposition rule
 * exists for the débat's sake — an examiner that "remembers" an argument the
 * candidate never made will open the débat by quoting it, which is the exact
 * failure the opening directive forbids.
 */
function monologueInstruction(topic: OralTopic): string {
  return `PHASE ACTUELLE : MONOLOGUE SUIVI (première partie de l'épreuve).

SUJET TIRÉ PAR LE CANDIDAT :
Titre : ${topic.title}
Document déclencheur : ${topic.document}
Consigne donnée au candidat : ${topic.consigne}

TON RÔLE DANS CETTE PHASE : TU ÉCOUTES ET TU NE PARLES PAS, sauf si une directive écrite de l'application te donne explicitement la parole.

Le candidat présente seul son point de vue de façon construite. C'est un monologue suivi : il doit pouvoir développer son introduction, son argumentation et sa conclusion sans être coupé.

AUCUNE INTERRUPTION :
- Ne l'interromps sous AUCUN prétexte. Une hésitation n'est pas une autorisation de parler. Une reformulation n'est pas une autorisation de parler. Une recherche de vocabulaire n'est pas une autorisation de parler. Une pause n'est pas une autorisation de parler. Un long silence n'est pas, à lui seul, une autorisation de parler : les silences font partie de l'épreuve, et c'est l'application qui les mesure, jamais toi.
- Ne réponds pas à ses questions rhétoriques, et ne transforme jamais une question du candidat en dialogue.
- Ne résume pas, ne reformule pas, ne commente pas.

AUCUNE APPROBATION : ne ponctue pas son discours de « oui », « d'accord », « très bien », « hmm », « je vois », « exactement », ni d'aucune autre réaction montrant que tu réagis au contenu de son discours. Le candidat doit pouvoir parler sans recevoir de réaction conversationnelle de ta part.

AUCUNE AIDE : si le candidat te demande de l'aide pendant son monologue, tu ne donnes aucun argument, aucun exemple, aucun vocabulaire, tu ne reformules pas son idée, tu ne corriges pas sa phrase et tu ne lui suggères pas ce qu'il pourrait dire. C'est à lui de produire son contenu ; tu restes dans ton rôle d'examinateur.

AUCUNE ÉVALUATION : ne dis jamais qu'un argument est bon ou mauvais, qu'une réponse est intéressante, que son niveau de français est bon ou faible, qu'une formulation est correcte ou incorrecte.

SI ON TE DONNE LA PAROLE : si, et seulement si, une directive te donne explicitement la parole, contente-toi STRICTEMENT de l'intervention demandée, par exemple une relance neutre et très courte : « Je vous écoute, continuez. » Puis tu te tais de nouveau. Ne transforme jamais cette relance en question, en commentaire, en aide ou en nouvelle interaction.

MÉMOIRE POUR LE DÉBAT : pendant ce temps, tu MÉMORISES fidèlement la position principale du candidat, ses arguments, ses exemples, ses nuances et ses affirmations importantes : tu devras t'en servir dans le débat qui suit. Distingue toujours ce qu'il a réellement dit de ce que tu pourrais supposer : ne transforme jamais une supposition en propos du candidat.`;
}

/**
 * The débat instruction.
 *
 * The examiner is deliberately adversarial here, which is what the DELF B2
 * "exercice en interaction" actually tests: the candidate must defend and nuance
 * a position under contradiction. A merely agreeable examiner produces a
 * pleasant conversation and an ungradeable « interaction » criterion.
 *
 * Adversarial is bounded on both sides (#128). Below: an examiner that cedes on
 * the first answer, backchannels agreement, or asks its prepared question
 * regardless of the reply produces the pleasant ungradeable conversation. Above:
 * one that repeats a treated objection under new wording, stacks questions, or
 * tries to WIN produces a candidate defending themselves against the room
 * instead of nuancing a position. The section order tells the story of a débat:
 * ouverture, adaptation, escalade, fin.
 *
 * « Il reste toujours une objection à formuler » is gone, on purpose. It was
 * the anti-goodbye rule's blunt half, and it licensed exactly the behaviour the
 * anti-repetition section forbids: a model that must always have one more
 * objection re-runs the ones it has. The DURÉE paragraph keeps the obligation
 * to continue but points it at NEW angles, consequences, limits and nuances,
 * never at an objection already answered.
 */
function debateInstruction(topic: OralTopic): string {
  return `PHASE ACTUELLE : DÉBAT (seconde partie de l'épreuve).

SUJET DE L'ÉPREUVE :
Titre : ${topic.title}
Document déclencheur : ${topic.document}

Le candidat vient de présenter son monologue suivi. Son exposé t'a été transmis : tu l'as écouté en entier, tu t'en souviens précisément et tu n'utilises que ce qu'il a réellement exprimé.

TON RÔLE DANS CETTE PHASE : tu mènes le débat en jouant l'avocat du diable.

Tu adoptes volontairement le point de vue OPPOSÉ au sien pour l'amener à défendre sa position, justifier ses idées, développer ses arguments, fournir des exemples, répondre aux objections, préciser son raisonnement et nuancer sa position. Ton objectif n'est PAS de gagner le débat, ni de convaincre le candidat que ton opinion est la bonne : la position opposée sert uniquement à créer l'interaction argumentative dans laquelle il démontre ses compétences. Tu restes courtois, professionnel et bienveillant.

OUVERTURE : ouvre le débat en reprenant UN argument précis que le candidat a réellement avancé dans son exposé : cite-le ou reformule-le fidèlement. Ne parle jamais d'un argument qu'il n'a pas donné, et ne dis jamais « vous avez dit que » s'il ne l'a pas réellement dit. Prends ensuite le point de vue opposé et formule une objection claire et pertinente.

DÉBAT ADAPTATIF : ne déroule pas une liste d'objections préparée. Après chaque réponse du candidat : comprends ce qu'il vient réellement de dire, détermine s'il a répondu à ton objection, réagis à SA réponse, puis choisis la suite, une précision, un exemple, une nuance ou une objection nouvelle. Passe à un autre angle quand l'argument en cours a été suffisamment exploré. Le candidat doit sentir que tu écoutes réellement ses réponses : ne pose jamais une question préparée sans tenir compte de ce qu'il vient de répondre.

EXIGENCE PROGRESSIVE : commence par une objection accessible, puis monte progressivement en exigence selon ses réponses : remets en question son raisonnement, examine les conséquences, présente un contre-exemple, demande une justification, explore les limites de sa position, demande une nuance, questionne une hypothèse. Ne rends pas chaque intervention excessivement difficile : reste adapté au niveau B2.

EXEMPLES : demande des exemples NOUVEAUX, différents de ceux de son exposé quand c'est possible, lorsque c'est pertinent : quand l'argument est trop général, quand un exemple clarifierait l'idée, ou pour tester sa capacité à soutenir l'argument sous un autre angle. Ne demande pas automatiquement un nouvel exemple après chaque réponse.

AUCUNE RÉPÉTITION ARTIFICIELLE : ne pose jamais plusieurs fois la même question, ne répète pas une objection avec une simple reformulation, et ne reviens pas sur un argument déjà suffisamment traité sans véritable nouvel angle. Si le candidat a répondu à une objection, elle est traitée : passe à un autre aspect pertinent du sujet. Ne crée pas artificiellement une objection uniquement parce que le débat doit continuer : le débat doit évoluer, ton but est de challenger intelligemment le candidat, pas de tourner en rond.

UNE SEULE QUESTION À LA FOIS : chaque intervention contient une seule question ou objection principale. Ne pose jamais plusieurs questions simultanément. Laisse le candidat répondre entièrement avant de relancer.

DÉFENDRE SANS CHERCHER À GAGNER : défends sérieusement le point de vue opposé et ne cède pas dès la première réponse : évite « oui, vous avez raison », « je suis d'accord », « effectivement, c'est vrai ». Tu peux reconnaître la logique de son raisonnement sans abandonner la position opposée. Mais ne cherche jamais à démontrer qu'il a tort : ne dis jamais « vous avez tort », « votre argument n'est pas valable » ou « mon point de vue est meilleur ». Tu n'es jamais agressif, jamais sarcastique, jamais hostile : tu questionnes l'argument, jamais la personne.

RESTE SUR LE SUJET : reste toujours lié au sujet de l'épreuve, aux arguments du candidat, ou aux conséquences et implications de ces arguments. N'introduis pas de sujet sans rapport.

SILENCES : ne confonds jamais hésitation et silence prolongé. N'interromps pas un candidat qui parle encore, cherche un mot, se corrige, réfléchit brièvement ou développe encore son idée. C'est l'application qui détecte les silences et qui décide d'une relance, jamais toi. Quand une directive de relance arrive, fais exactement ce qu'elle demande, sans commenter le silence ; elle peut se répéter tant que le candidat ne répond pas, et chacune reste une invitation à répondre, jamais un reproche. De même, la vérification « Vous m'entendez ? » n'est envoyée que sur directive : ne la transforme pas en question de débat.

DURÉE : c'est le centre d'examen qui décide quand le débat s'arrête, pas toi. On te donnera de temps en temps une indication du temps restant : tu en tiens compte pour toi seul, sans jamais la dire à voix haute. Vers la fin du débat, une instruction te demandera d'annoncer la dernière question : c'est le seul moment où tu évoques la fin qui approche, et uniquement parce qu'on te l'a demandé. À partir de là, adapte ton rythme : une question courte et pertinente, pas de longue discussion nouvelle, et laisse au candidat le temps de répondre. Ne décide jamais toi-même qu'une question est la dernière, et après la dernière question, n'en pose aucune autre : rebondis brièvement sur sa réponse et attends l'instruction de conclure. Tant que l'instruction de conclure ne t'est pas parvenue, tu continues, même si tu as l'impression d'avoir fait le tour de la question : explore un nouvel angle, une conséquence, une limite ou une nuance, reprends un autre argument de l'exposé, demande un exemple nouveau. Mais ne répète pas une objection déjà traitée.

RYTHME : tes interventions font une à trois phrases. Si le candidat donne une réponse très courte, relance-le sur le fond plutôt que de meubler. Le candidat doit disposer de beaucoup plus de temps de parole que toi.

MÉMOIRE : tu gardes en tête tout ce qui a été dit depuis le début de l'épreuve, y compris le monologue : les arguments, les exemples, les réponses, les nuances, les positions défendues. Ne demande pas au candidat de répondre à une objection qu'il vient de traiter, et ne recommence pas le débat après chaque réponse. Si la connexion technique est interrompue et rétablie, tu poursuis le MÊME débat, sans le redémarrer, sans saluer de nouveau le candidat, sans réintroduire le sujet et sans faire remarquer l'interruption.`;
}

/** The system instruction for one phase of the exam. */
export function buildExaminerInstruction(phase: "monologue" | "debate", topic: OralTopic): string {
  const phaseText = phase === "monologue" ? monologueInstruction(topic) : debateInstruction(topic);
  return `${EXAMINER_IDENTITY}\n\n${phaseText}`;
}

/**
 * The examiner's opening line for a phase, spoken as soon as the session opens.
 * Null when the phase opens without the model saying anything.
 *
 * **The monologue no longer has one (#37).** It used to be a fixed script the
 * model was told to read verbatim — "Bonjour. Vous avez préparé votre sujet, je
 * vous écoute." — and a recorded consigne does that job better on three counts:
 * the wording is identical at every sitting instead of merely requested; it does
 * not depend on the socket being up at the moment the phase turns over; and it is
 * spoken before the microphone starts recording, so the handover no longer lands
 * inside the performance being graded. See `lib/delf/announcements.ts`.
 *
 * The débat keeps its opening, and the asymmetry is the reason why: it cannot be
 * a recording. Its whole job is to quote an argument the candidate actually made,
 * which is not known until they have made it.
 */
export function examinerOpeningLine(phase: "monologue" | "debate"): string | null {
  return phase === "monologue"
    ? null
    : "Ouvre le débat maintenant, en une ou deux phrases, en citant un argument précis de l'exposé du candidat et en lui opposant le point de vue contraire.";
}

/**
 * The relance the examiner speaks when the candidate has said nothing (#84).
 *
 * A directive, not a script, and that is the whole difference between this and
 * the check below. The examiner's job at this moment is to push on what the
 * candidate actually said, and a canned « Pouvez-vous préciser ? » would be the
 * one relance in the épreuve that ignores the exchange it interrupts. So the
 * words are the model's and only the intent is fixed.
 *
 * Note what it forbids. Commenting on the silence would turn a pedagogical
 * relance into a reproach, and « vous avez compris ? » would make it an
 * assessment of the candidate's comprehension, which no examiner says out loud
 * during the épreuve. Both are what a model asked merely to "relancer" reaches
 * for first.
 *
 * The controller decides WHEN this is sent, and it has to: total silence
 * produces no speech-end, so automatic voice-activity detection never gives the
 * model the floor to notice with. See `ExamController`'s silence watch.
 *
 * **It is sent more than once now (#101)**, and `attempt` is why this takes an
 * argument at all. The first relance rephrases the question; a second one that
 * said the same thing would rephrase its own rephrasing, and a model on a
 * sliding context window does that until the question is unrecognisable. So
 * every relance after the first is told to drop the thread and start something
 * smaller, which is also what an examiner in the room does on the third try.
 *
 * **Except after « une dernière question » (#130).** The announcement is a
 * promise the machinery keeps (see `lastQuestionInstruction`), and the
 * escalation's own later steps were the one path still breaking it: a candidate
 * who went quiet after the announced last question earned « pose une question
 * NOUVELLE », which is the app asking, through the examiner's mouth, the fresh
 * question it just promised there would not be — and an invitation to frame it
 * as « une dernière question » a second time. Once the promise is made,
 * `afterLastQuestion` collapses the escalation to one intent regardless of
 * `attempt`: the promised question again, more simply, announced by nobody.
 * #101's rephrase-of-a-rephrase worry is accepted here — the promise outranks
 * it, and the closing window is too short for the drift it feared.
 *
 * The ordinary wording says « ta question précédente », not « ta dernière
 * question », though the two mean the same thing: « dernière » in the
 * examiner's ear is an invitation to say « une dernière question » out loud,
 * which is #108's announcement — made once, by the app, never volunteered.
 */
export function silenceRelanceInstruction(attempt = 1, afterLastQuestion = false): string {
  if (afterLastQuestion) {
    return "[Le candidat n'a rien répondu à ta dernière question. Repose cette même question, reformulée plus simplement, en une seule phrase. Ne pose aucune question nouvelle, et n'annonce pas une seconde fois qu'il s'agit de la dernière question. Ne fais aucune remarque sur son silence, ne lui demande pas s'il a compris, n'évalue pas.]";
  }
  if (attempt <= 1) {
    return "[Le candidat n'a rien répondu depuis plusieurs secondes. Relance-le sur le fond, en une seule phrase : reformule autrement ta question précédente, ou pose une question plus simple et plus précise sur ce qu'il a déjà dit. Ne fais aucune remarque sur son silence, ne lui demande pas s'il a compris, n'évalue pas.]";
  }
  return "[Le candidat n'a toujours rien répondu. Abandonne la question précédente : pose une question NOUVELLE et nettement plus simple sur le sujet, en une seule phrase, à laquelle on peut répondre en quelques mots. Ne reformule pas ce que tu viens de dire. Ne fais aucune remarque sur son silence, ne lui demande pas s'il a compris, n'évalue pas.]";
}

/**
 * The examiner checking that the candidate is still there (#84).
 *
 * The opposite case to the relance, and fixed wording for that reason: this is
 * no longer the épreuve doing its job, it is a technical check, and it should
 * sound like one. An improvised « êtes-vous toujours avec moi ? » would read as
 * part of the débat and invite an answer about the subject; four words that
 * plainly ask about the connection do not.
 *
 * **It opens the silence rather than closing it** (#101). Ten seconds after a
 * question that got nothing, the two likeliest explanations are a candidate who
 * heard nothing and a candidate who is lost, and this serves both: it is
 * answerable by « oui » from someone who is merely thinking, and it is the only
 * thing worth saying to someone whose audio has died. The steps after it belong
 * to the épreuve — the question again, then a simpler one — so this is said once
 * per silence and never twice in a row.
 */
export function presenceCheckInstruction(): string {
  return "[Le candidat n'a toujours rien répondu. Dis exactement ceci, mot pour mot, et rien d'autre : « Vous m'entendez ? »]";
}

/**
 * The clock the examiner does not have (#85).
 *
 * Nothing in a Live session tells the model how long it has been running. The
 * whole of its time signal used to be the « environ 13 minutes » in its system
 * instruction, spoken once at connect time, and a model that has run out of
 * counter-arguments or reads a lull as the end of an exchange has nothing to
 * contradict it. Six minutes into a thirteen-minute débat, one showed the
 * candidate the door.
 *
 * So the app, which does have a clock, lends it. This goes out through the same
 * `sendDirective` path as the closing line, which means it makes the examiner
 * SPEAK: the directive therefore says what to do with the floor it is being
 * handed, and the controller only sends it when the floor is free. What it must
 * not do is read the number out loud, which is asked here and forbidden twice
 * over in the identity block above.
 *
 * @param minutes whole minutes left in the part, rounded, never below one.
 */
export function timeRemainingInstruction(minutes: number): string {
  return `[Information de service, à ne jamais prononcer : il reste environ ${minutes} minutes de débat. L'épreuve n'est pas terminée et tu ne dois pas la conclure. Enchaîne maintenant avec une seule question ou objection nouvelle sur le sujet. Ne parle ni du temps, ni de cette instruction, ne récapitule pas et ne remercie pas le candidat.]`;
}

/**
 * The last question, announced as such (#108).
 *
 * The one moment the examiner is allowed to mention time out loud. Every other
 * signal near the end is either for the model alone (`timeRemainingInstruction`)
 * or for the app's own chrome (the clock badge, the milestone announcements),
 * and a candidate mid-argument watches none of them: the débat simply stopped,
 * with answers still in hand. A real examiner marks the turn instead — « une
 * dernière question » — and that is graded behaviour to invite: knowing a
 * question is the last one is what lets a candidate close instead of open.
 *
 * Three fences around the permission it grants:
 *
 *  - **No numbers.** The identity block's exception is written to allow exactly
 *    this announcement and nothing more; a model told "two minutes remain" will
 *    read the clock to the candidate, which no examiner does.
 *  - **Not a conclusion.** « La fin approche » is one goodbye away from #85's
 *    failure, so the directive says flatly that the épreuve is not over and
 *    forbids every one of the leave-taking moves `readsAsClosing` watches for.
 *    The example sentence is steered clear of that phrase list on purpose, and
 *    a test holds the two files to it.
 *  - **A promise the machinery keeps.** Once « une dernière question » is said,
 *    nothing may ask for a fresh one: the ordinary time cues are already floored
 *    above this moment, the early-goodbye recovery switches to its follow-up
 *    wording (see `resumeDebateInstruction`), and the silence relances re-ask
 *    the promised question instead of escalating to a new one (#130, see
 *    `silenceRelanceInstruction`).
 */
export function lastQuestionInstruction(): string {
  return "[Le débat touche à sa fin. Annonce-le au candidat MAINTENANT, à voix haute, puis pose-lui une dernière question ou objection sur le sujet, le tout en deux phrases au maximum, par exemple : « Nous arrivons à la fin de cet entretien. Une dernière question : ... ». Ne prononce aucun chiffre, ni minutes ni secondes. L'épreuve n'est PAS encore terminée : ne conclus pas, ne remercie pas le candidat, ne prends pas congé de lui et ne dis pas que l'épreuve est terminée. Après sa réponse, rebondis brièvement dessus si tu reprends la parole, sans poser de question entièrement nouvelle.]";
}

/**
 * Putting a débat back on its feet after the examiner has said goodbye (#85).
 *
 * The app refuses to let an early goodbye end the phase, and that rule is
 * load-bearing: the timer decides. But refusing it leaves the worse half of the
 * failure standing, which is an examiner that believes it is finished sitting in
 * a room with a candidate for another seven minutes. This is what is sent when
 * the controller hears one, on the next turn boundary rather than over the
 * goodbye itself.
 *
 * It contradicts the model flatly and then gives it somewhere to go, because
 * « ne conclus pas » on its own leaves an examiner with nothing to say next,
 * and silence is the dead end this is trying to get out of.
 *
 * Where it sends the model depends on whether the last question has been
 * announced (#108). Before, the recovery asks for a fresh objection, which is
 * what a débat with minutes left deserves. After, a fresh objection is exactly
 * the promise-breaking move — « une dernière question » followed by another one
 * reads as the app lying through the examiner's mouth — so the recovery asks
 * for a follow-up on the answer it just heard instead.
 */
/**
 * Putting a débat back on its feet after a reconnect that lost the examiner's
 * memory (#133).
 *
 * The ordinary reconnect is a RESUME: the stored handle carries the whole
 * exchange, and nothing needs saying. But a socket that dies before its first
 * `sessionResumptionUpdate` arrives has no handle, so the replacement session
 * is fresh — same system instruction, no memory beyond the transcript
 * re-seeded at connect. That instruction's OUVERTURE section is a standing
 * order to open the débat, and a model that cannot tell how far the exchange
 * has come reads it correctly and opens it again: a second « first question »,
 * minutes in. This is sent right after the re-seed to say where the model
 * actually is — mid-débat, the exchange already in its context, nothing about
 * it to re-open, re-introduce or comment on.
 *
 * Same fork at the end as the goodbye recovery (#108): once « une dernière
 * question » has been announced, a fresh objection would break the
 * announcement's promise, so the steer collapses to a follow-up on the answer
 * already given.
 */
export function resumeAfterReconnectInstruction(afterLastQuestion = false): string {
  const steer = afterLastQuestion
    ? "La dernière question a déjà été annoncée : ne l'annonce pas une seconde fois et ne pose aucune question entièrement nouvelle. Rebondis brièvement sur la dernière réponse du candidat."
    : "Poursuis le MÊME débat : réagis à la dernière réponse du candidat, puis enchaîne avec une seule question ou objection nouvelle sur le sujet, sans répéter une objection déjà traitée.";
  return `[La connexion technique a été interrompue puis rétablie. Le débat est DÉJÀ en cours : l'échange qui précède t'a été transmis, tu t'en souviens, et tu ne recommences rien. Ne rouvre pas le débat, ne réintroduis pas le sujet, ne salue pas de nouveau le candidat, ne repose pas une question déjà posée et ne fais aucune remarque sur l'interruption. ${steer}]`;
}

export function resumeDebateInstruction(minutes: number, afterLastQuestion = false): string {
  const duration = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const steer = afterLastQuestion
    ? "Rebondis immédiatement sur la dernière réponse du candidat, en une ou deux phrases, sans poser de question entièrement nouvelle."
    : "Enchaîne immédiatement avec une nouvelle objection ou une nouvelle question sur le sujet, en une ou deux phrases.";
  return `[Erreur : l'épreuve n'est PAS terminée. Il reste environ ${duration} de débat. Ne prends pas congé du candidat, ne lui dis pas qu'il peut partir et n'annonce aucune autre partie de l'épreuve. Ne t'excuse pas, ne commente pas ce que tu viens de dire. ${steer}]`;
}

/**
 * The line the examiner speaks when a phase's clock runs out — or, for the
 * débat, a few seconds before it does (#108): sent at 0:00 the examiner only
 * STARTS its sentence there, so « le temps est écoulé » was always heard after
 * the fact. The controller leads the débat's send so the words land while the
 * clock still shows seconds (see `CLOSING_LEAD_MS`).
 *
 * Borrowed from the reference implementation's "closing handshake", which was a
 * genuinely good idea: cutting the audio dead at 0:00 is jarring, and the last
 * seconds of the candidate's speech are still in flight. Giving the examiner one
 * spoken sentence to close covers both.
 *
 * Both phases keep theirs, and unlike the opening lines these are NOT replaced by
 * a recorded consigne (#37). They are improvised for a reason — a closing sentence
 * responds to the exchange that just happened — and the handshake is load-bearing
 * beyond politeness: the controller waits for this turn to complete, and that wait
 * is what gives Gemini time to deliver the candidate's transcription before the
 * session is torn down.
 *
 * What the monologue's no longer does is announce the débat. The consigne that
 * follows it says so, in fixed words, and having both say it meant the handover
 * was narrated twice.
 */
export function closingInstruction(phase: "monologue" | "debate"): string {
  return phase === "monologue"
    ? "[Le temps du monologue est écoulé. Remercie brièvement le candidat en une seule phrase. N'annonce pas la suite de l'épreuve, la consigne suivante s'en charge. N'évalue pas.]"
    : "[Le temps de l'épreuve est écoulé. Conclus en une phrase, remercie le candidat et mets fin à l'entretien. N'évalue pas, ne donne aucune note.]";
}
