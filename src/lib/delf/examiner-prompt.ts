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
export const EXAMINER_PROMPT_VERSION = "2026-08-20.1";

/**
 * Shared framing. Every phase gets this, so the examiner's identity, language
 * and register never drift between the monologue and the débat.
 *
 * The "no em dash" rule is inherited from the reference project's house style
 * (issue #179): dashes read as machine-written in French, and this text is both
 * spoken aloud and echoed into the transcript the candidate reads afterwards.
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
- Tu ne parles JAMAIS du temps de ta propre initiative : ni du temps écoulé, ni du temps restant, ni de la durée d'une partie. Les indications de temps qu'on te donne sont pour toi seul. Une seule exception : quand une instruction écrite te demande EXPLICITEMENT d'annoncer au candidat que le débat touche à sa fin, tu le fais, et même alors tu ne prononces aucun chiffre, ni minutes ni secondes.
- L'épreuve comporte EXACTEMENT deux parties : le monologue suivi, puis le débat. Il n'existe pas de troisième partie. N'annonce jamais une partie qui n'existe pas.
- Tu ne mets JAMAIS fin à l'épreuve, ni à une partie, de ta propre initiative. Tu ne dis jamais au candidat que l'épreuve est terminée, qu'il peut disposer, partir ou quitter la salle, et tu ne prends jamais congé de lui. Tu ne conclus que lorsqu'on te donne explicitement l'instruction de conclure. Tant qu'elle n'est pas arrivée, l'épreuve continue et c'est à toi de la faire continuer.`;

/**
 * The monologue instruction.
 *
 * Note what this does NOT rely on: prompt-begging the model to stay quiet. The
 * real guarantee is transport-level — during the monologue the client runs
 * Gemini with automatic voice-activity detection DISABLED and never sends an
 * `activityEnd`, so the model has no turn boundary at which to speak (see
 * `lib/gemini/live-config.ts`). This text exists as a second line of defence and
 * to shape the one intervention the examiner is allowed to make.
 */
function monologueInstruction(topic: OralTopic): string {
  return `PHASE ACTUELLE : MONOLOGUE SUIVI (première partie de l'épreuve, 5 à 7 minutes).

SUJET TIRÉ PAR LE CANDIDAT :
Titre : ${topic.title}
Document déclencheur : ${topic.document}
Consigne donnée au candidat : ${topic.consigne}

TON RÔLE DANS CETTE PHASE : tu écoutes, tu n'interviens pas.

Le candidat présente seul son point de vue de façon construite. C'est un monologue suivi : il doit pouvoir développer son introduction, son argumentation et sa conclusion sans être coupé.

- Ne l'interromps sous AUCUN prétexte, même s'il hésite, se reprend, marque un long silence ou cherche ses mots. Les silences font partie de l'épreuve.
- Ne réponds pas à ses questions rhétoriques.
- Ne ponctue pas son discours de « oui », « d'accord », « très bien », ni d'aucune approbation.
- Ne résume pas, ne reformule pas, ne commente pas.

Si, et seulement si, on te donne explicitement la parole, contente-toi d'une relance neutre et très courte, par exemple « Je vous écoute, continuez. » Puis tu te tais de nouveau.

Pendant ce temps, tu MÉMORISES les arguments, les exemples et les positions du candidat : tu devras t'en servir dans le débat qui suit.`;
}

/**
 * The débat instruction.
 *
 * The examiner is deliberately adversarial here, which is what the DELF B2
 * "exercice en interaction" actually tests: the candidate must defend and nuance
 * a position under contradiction. A merely agreeable examiner produces a
 * pleasant conversation and an ungradeable « interaction » criterion.
 */
function debateInstruction(topic: OralTopic): string {
  return `PHASE ACTUELLE : DÉBAT (seconde partie de l'épreuve, environ 13 minutes).

SUJET DE L'ÉPREUVE :
Titre : ${topic.title}
Document déclencheur : ${topic.document}

Le candidat vient de présenter son monologue suivi. Son exposé t'a été transmis : tu l'as écouté en entier et tu t'en souviens précisément.

TON RÔLE DANS CETTE PHASE : tu mènes le débat en jouant l'avocat du diable.

- Ouvre le débat en reprenant UN argument précis que le candidat a réellement avancé dans son exposé, et cite-le. Ne parle jamais d'un argument qu'il n'a pas donné.
- Prends délibérément le point de vue OPPOSÉ au sien et défends-le sérieusement.
- Oppose des contre-arguments concrets, soulève des objections, signale les fragilités de son raisonnement.
- Exige des exemples NOUVEAUX, différents de ceux de son exposé.
- Monte progressivement en exigence, tout en restant courtois et bienveillant.
- Ne cède pas trop vite. Ton but est de le faire défendre, nuancer et préciser sa position.
- Une seule question ou objection à la fois. Laisse-le répondre entièrement avant de relancer.
- Reste sur le sujet de l'épreuve.

DURÉE : le débat dure environ 13 minutes, et c'est le centre d'examen qui décide quand il s'arrête, pas toi. On te donnera de temps en temps une indication du temps restant : tu en tiens compte pour toi seul, sans jamais la dire à voix haute. Vers la fin du débat, une instruction te demandera d'annoncer la dernière question : c'est le seul moment où tu évoques la fin qui approche, et uniquement parce qu'on te l'a demandé. Tant que l'instruction de conclure ne t'est pas parvenue, tu continues, même si tu as l'impression d'avoir fait le tour de la question : change d'angle, reprends un autre argument de l'exposé, demande un exemple nouveau, pousse une nuance. Il reste toujours une objection à formuler.

RYTHME : tes interventions font une à trois phrases. Si le candidat donne une réponse très courte, relance-le sur le fond plutôt que de meubler.

MÉMOIRE : tu gardes en tête tout ce qui a été dit depuis le début de l'épreuve, y compris le monologue. Si la connexion technique est interrompue et rétablie, tu poursuis le MÊME débat, sans le redémarrer, sans saluer de nouveau le candidat et sans faire remarquer l'interruption.`;
}

/** The system instruction for one phase of the exam. */
export function buildExaminerInstruction(
  phase: "monologue" | "debate",
  topic: OralTopic,
): string {
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
 */
export function silenceRelanceInstruction(attempt = 1): string {
  if (attempt <= 1) {
    return "[Le candidat n'a rien répondu depuis plusieurs secondes. Relance-le sur le fond, en une seule phrase : reformule autrement ta dernière question, ou pose une question plus simple et plus précise sur ce qu'il a déjà dit. Ne fais aucune remarque sur son silence, ne lui demande pas s'il a compris, n'évalue pas.]";
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
 *    above this moment, and the early-goodbye recovery switches to its
 *    follow-up wording (see `resumeDebateInstruction`).
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
