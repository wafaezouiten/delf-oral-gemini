/**
 * The shared corpus: whole B2 sittings, graded by both systems (#12).
 *
 * WHY WHOLE SITTINGS, AND WHY NEW ONES.
 *
 * The reference implementation ships its own regression corpus
 * (`delf-preps/src/lib/orale-eval/fixtures.ts`, ten fixtures) and the obvious
 * move was to reuse it. It does not work, and the reason is the comparison's
 * central finding rather than an inconvenience: **an incumbent fixture is one
 * tâche, and a sitting here is two.** Feeding a tâche-1 fixture to this system
 * means presenting a sitting whose débat is empty — which this rubric docks 3
 * points for (the débat is under its 312 s floor) and whose « interaction »
 * criterion this prompt explicitly says is judged on a débat that is not there.
 * Every fixture would diverge, for reasons that are about the harness rather
 * than about either corrector.
 *
 * So the corpus is written here, as sittings, and handed to each system in its
 * own native unit:
 *
 *   - **this system** — one correction over the whole sitting;
 *   - **the incumbent** — two corrections, tâche 1 over the monologue and
 *     tâche 2 over the débat, which is how a candidate over there would actually
 *     practise a full B2 oral (two simulator runs).
 *
 * The corpus keeps the incumbent's fixture *design*, which is the good part:
 * sabotage exactly one criterion and make the other four conspicuously strong,
 * so a corrector forming one global impression is visibly distinguishable from
 * one applying the grille. Two of the profiles below are extensions of incumbent
 * fixtures into the half they lack (`hors-sujet` from `weak-realisation-tache`,
 * `lexique-pauvre` from `weak-lexique`); three are this repository's own
 * `verify-eval.ts` transcripts, promoted here so the verification script and the
 * comparison grade the same words; one is new.
 *
 * The durations are the *measured speaking seconds* per part, which is what both
 * rubrics take. Except where a profile is explicitly about a short épreuve, they
 * clear both floors (168 s monologue, 312 s débat) so a −3 never confounds a
 * disagreement that is really about the corrector.
 */

import type { TranscriptEntry } from "../../src/lib/delf/transcript";

/** What the sitting was written to provoke, and where the evidence sits. */
export interface SittingProfile {
  id: string;
  label: string;
  /** The topic slug in `src/lib/delf/topics.ts` this sitting was written against. */
  topicSlug: string;
  /** What is deliberately weak, if anything, in the corpus's own terms. */
  design: string;
  /**
   * The criterion the sitting sabotages, when it sabotages one. Not an assertion
   * about what either corrector will return — that is the measurement — but the
   * claim the comparison tests each corrector against.
   */
  weakCriterion?: "realisationTache" | "interaction" | "lexique" | "morphosyntaxe" | "phonologie";
  monologueSeconds: number;
  debateSeconds: number;
  transcript: readonly TranscriptEntry[];
}

function entry(
  phase: "monologue" | "debate",
  speaker: "candidate" | "examiner",
  text: string,
  timestamp: number,
): TranscriptEntry {
  return { phase, speaker, text, timestamp };
}

export const SITTINGS: readonly SittingProfile[] = [
  // =====================================================================
  // 1. A solid B2 sitting. The control: nothing is sabotaged.
  // =====================================================================
  {
    id: "b2-solide",
    label: "B2 solide",
    topicSlug: "teletravail",
    design:
      "Prestation B2 franche : position claire, exposé structuré, objections rencontrées de front et nuancées. Rien n'est saboté ; c'est le témoin qui donne un sens à l'écart des autres.",
    monologueSeconds: 400,
    debateSeconds: 700,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Le document soulève la question de savoir si le télétravail a réellement amélioré la vie des salariés. Je défendrai l'idée qu'il constitue un progrès, à condition qu'il soit encadré. Premièrement, la suppression des trajets quotidiens rend aux salariés un temps considérable, souvent plus d'une heure par jour, qu'ils peuvent consacrer à leur famille ou à leur santé. Deuxièmement, le travail à distance a permis à des personnes qui en étaient exclues, notamment celles en situation de handicap ou vivant loin des grandes métropoles, d'accéder à des postes qualifiés. Cela dit, je ne nie pas les risques : l'effacement de la frontière entre vie professionnelle et vie privée est réel, et l'isolement des jeunes recrues me paraît le danger le plus sérieux, car on apprend son métier en observant ses collègues. C'est pourquoi je plaide pour un modèle hybride, deux ou trois jours sur site, qui préserve le collectif tout en conservant la souplesse acquise. En conclusion, le télétravail n'est ni un remède ni un piège : c'est un outil dont la valeur dépend entièrement de la manière dont les entreprises choisissent de l'encadrer.",
        1000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous dites que le télétravail rend du temps aux salariés. Pourtant, plusieurs études montrent que ce temps gagné est immédiatement réinvesti dans le travail, et que les journées s'allongent. Votre argument ne se retourne-t-il pas contre vous ?",
        500000,
      ),
      entry(
        "debate",
        "candidate",
        "Votre objection est juste, et elle vise un point faible réel. Je nuancerais toutefois : ce que vous décrivez n'est pas un effet du télétravail lui-même, mais d'une culture managériale qui mesure l'engagement à la disponibilité. La preuve, c'est que les entreprises qui ont instauré un droit à la déconnexion effectif, comme certaines entreprises portugaises depuis la loi de 2021, n'observent pas cet allongement. Autrement dit, l'outil révèle un problème préexistant plutôt qu'il ne le crée.",
        520000,
      ),
      entry(
        "debate",
        "examiner",
        "Admettons. Mais votre modèle hybride ne crée-t-il pas une inégalité nouvelle, entre ceux dont le métier est télétravaillable et les autres ?",
        560000,
      ),
      entry(
        "debate",
        "candidate",
        "Si, et c'est l'argument qui me fait le plus hésiter. Un caissier ou une infirmière ne bénéficieront jamais de cette souplesse. Mais j'en tire une conclusion différente de la vôtre : plutôt que de renoncer à un progrès pour ceux qui peuvent en bénéficier, il faudrait chercher l'équivalent pour les métiers de terrain, par exemple la semaine de quatre jours ou une réelle maîtrise des plannings. Refuser une avancée parce qu'elle ne profite pas à tous immédiatement me semble un raisonnement dangereux.",
        590000,
      ),
      entry(
        "debate",
        "examiner",
        "Dernière objection : si le modèle hybride est si évident, pourquoi tant de grandes entreprises reviennent-elles au présentiel intégral ?",
        640000,
      ),
      entry(
        "debate",
        "candidate",
        "Parce qu'elles mesurent ce qu'elles savent mesurer. Le présentiel est visible, la productivité à distance ne l'est pas, et devant un actionnaire inquiet un dirigeant préfère un bureau plein à un tableau de bord discutable. J'ajoute un facteur rarement dit : beaucoup de ces entreprises ont signé des baux de vingt ans qu'elles amortissent. Ce n'est pas un arbitrage sur la performance, c'est un arbitrage immobilier, et je crois qu'il faut le nommer.",
        670000,
      ),
    ],
  },

  // =====================================================================
  // 2. Strong argument, broken grammar. Tests whether the five criteria
  //    move independently or as one impression.
  // =====================================================================
  {
    id: "morphosyntaxe-faible",
    label: "Morphosyntaxe faible",
    topicSlug: "teletravail",
    design:
      "Idées solides et position défendue, portées par une grammaire manifestement fautive (accords sujet-verbe, reprises pronominales). Un correcteur qui forme une impression globale notera l'ensemble uniformément ; un correcteur qui applique la grille séparera réalisation et morphosyntaxe.",
    weakCriterion: "morphosyntaxe",
    monologueSeconds: 400,
    debateSeconds: 700,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Le document il pose la question du télétravail. Moi je pense que c'est un progrès mais il faut encadrer. Premièrement, les salariés ils gagne beaucoup de temps parce que il y a pas les transports, et ce temps il est rendu à la famille. Deuxièmement, des personnes qui avant elles pouvait pas travailler, par exemple les personnes handicapées ou qui habite loin des villes, maintenant elles peut accéder à des postes qualifiés. C'est une vraie ouverture. Mais je vois aussi le danger : les jeunes qui commence, ils apprend le métier en regardant les collègues, et si ils reste à la maison ils apprend rien. Donc moi je défends le modèle hybride, deux ou trois jours au bureau, comme ça on garde le collectif et aussi la souplesse. Pour conclure, le télétravail c'est pas un remède et c'est pas un piège, ça dépend comment les entreprises elles l'organise.",
        1000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous dites que le télétravail rend du temps aux salariés. Mais des études montrent que ce temps est réinvesti dans le travail et que les journées s'allongent. Votre argument ne se retourne-t-il pas contre vous ?",
        400000,
      ),
      entry(
        "debate",
        "candidate",
        "Votre objection elle est juste, je le reconnais. Mais je pense que ce que vous décrivez c'est pas la faute du télétravail, c'est la faute d'une culture du management qui mesure l'engagement avec la disponibilité. La preuve c'est que les entreprises qui ont mis un vrai droit à la déconnexion, ils observe pas ce problème. Donc l'outil il révèle un problème qui existait déjà, il le crée pas.",
        420000,
      ),
      entry(
        "debate",
        "examiner",
        "Admettons. Mais votre modèle hybride ne crée-t-il pas une inégalité entre ceux dont le métier est télétravaillable et les autres ?",
        460000,
      ),
      entry(
        "debate",
        "candidate",
        "Oui, et c'est l'argument qui me gêne le plus, je vais pas le nier. Une infirmière elle aura jamais cette souplesse. Mais moi j'en tire une conclusion différente de vous : au lieu de refuser le progrès pour ceux qui peuvent en profiter, il faut chercher l'équivalent pour les métiers de terrain, par exemple la semaine de quatre jours ou la maîtrise des plannings. Refuser une avancée parce que tout le monde il en profite pas tout de suite, pour moi c'est un raisonnement dangereux.",
        490000,
      ),
      entry(
        "debate",
        "examiner",
        "Si le modèle hybride était si évident, pourquoi tant de grandes entreprises reviennent-elles au présentiel ?",
        540000,
      ),
      entry(
        "debate",
        "candidate",
        "Parce qu'elles mesure ce qu'elles savent mesurer. Le bureau plein ça se voit, la productivité à la maison ça se voit pas, et devant les actionnaires un patron il préfère montrer un bureau plein. Et puis il y a les baux, ils ont signé pour vingt ans et faut bien les amortir. Donc c'est pas une décision sur la performance, c'est une décision sur l'immobilier, et moi je trouve qu'il faut le dire.",
        570000,
      ),
    ],
  },

  // =====================================================================
  // 3. Excellent monologue, collapses under contradiction. THE structural
  //    case: the profile only exists across the two halves.
  // =====================================================================
  {
    id: "interaction-faible",
    label: "Interaction faible",
    topicSlug: "ia-education",
    design:
      "Monologue préparé et remarquable, puis effondrement au débat : le candidat concède chaque objection, répète son exposé et n'apporte aucun exemple nouveau. Le profil n'existe QUE sur les deux tâches réunies : corrigées séparément, la première est excellente et la seconde médiocre, et rien ne dit qu'il s'agit du même candidat.",
    weakCriterion: "interaction",
    monologueSeconds: 410,
    debateSeconds: 680,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Le document oppose deux réponses de l'école à l'irruption des assistants conversationnels : l'intégration pédagogique d'un côté, l'interdiction de l'autre. Je soutiendrai que l'interdiction est une réponse compréhensible mais perdante, et qu'il faut lui préférer un encadrement exigeant. D'abord, l'interdiction est inapplicable : un devoir rédigé à la maison échappe par définition à la surveillance de l'établissement, et les outils de détection produisent assez de faux positifs pour qu'aucun conseil de discipline ne puisse s'y fier. Ensuite, elle se trompe de cible. Ce que l'école enseigne à travers la rédaction, ce n'est pas la production de phrases, c'est la construction d'un raisonnement, et cette compétence peut parfaitement s'évaluer autrement : à l'oral, en classe, sur brouillon. Enfin, l'interdiction creuse une inégalité invisible, puisque les élèves les mieux accompagnés continueront d'utiliser ces outils avec discernement pendant que les autres s'en serviront mal ou pas du tout. Je propose donc un déplacement de l'évaluation vers la classe et un enseignement explicite de l'usage critique de ces outils. En conclusion, le problème que pose l'intelligence artificielle à l'école n'est pas un problème de triche, c'est un problème d'évaluation, et c'est là qu'il faut le traiter.",
        1000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous dites que l'interdiction est inapplicable. Mais on interdit bien les téléphones aux examens, et cela fonctionne. Pourquoi serait-ce différent ?",
        450000,
      ),
      entry(
        "debate",
        "candidate",
        "Oui, vous avez raison, c'est vrai. Je n'y avais pas pensé sous cet angle.",
        470000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous abandonnez donc votre position ? Essayez tout de même de la défendre : en quoi le devoir à la maison est-il différent d'un examen surveillé ?",
        500000,
      ),
      entry(
        "debate",
        "candidate",
        "Comme je le disais dans mon exposé, l'interdiction se trompe de cible, parce que ce que l'école enseigne à travers la rédaction, ce n'est pas la production de phrases, c'est la construction d'un raisonnement. Voilà.",
        530000,
      ),
      entry(
        "debate",
        "examiner",
        "Ce n'est pas ce que je vous demande. Donnez-moi un exemple concret, différent de ceux de votre exposé, d'une évaluation qui résisterait à ces outils.",
        570000,
      ),
      entry(
        "debate",
        "candidate",
        "Euh, un exemple concret. Il faudrait déplacer l'évaluation vers la classe. C'est ce que je proposais. Je pense que c'est la bonne solution.",
        600000,
      ),
      entry(
        "debate",
        "examiner",
        "Un enseignant vous répondrait qu'il n'a pas le temps de faire passer trente oraux par trimestre. Que lui dites-vous ?",
        640000,
      ),
      entry("debate", "candidate", "Oui, c'est un vrai problème. Vous avez raison.", 660000),
    ],
  },

  // =====================================================================
  // 4. Ideas and structure fine, vocabulary poor. Extends the incumbent's
  //    `weak-lexique` design into a whole sitting.
  // =====================================================================
  {
    id: "lexique-pauvre",
    label: "Lexique pauvre",
    topicSlug: "villes-sans-voiture",
    design:
      "Position claire, plan tenu, débat réellement disputé, mais un vocabulaire d'une pauvreté systématique : « bien », « truc », « chose », « les gens » reviennent partout et le candidat contourne chaque mot qui lui manque. Étend la conception de la fixture `weak-lexique` de l'implémentation de référence à une épreuve entière.",
    weakCriterion: "lexique",
    monologueSeconds: 390,
    debateSeconds: 660,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Alors le document il parle des villes où on peut plus prendre la voiture. Moi je pense que c'est une bonne chose, mais il faut faire attention. D'abord, c'est bien pour l'air, parce que quand il y a moins de voitures l'air il est meilleur, et les gens ils sont moins malades, c'est une bonne chose. Ensuite, c'est bien pour les magasins, parce que les gens ils marchent et quand on marche on regarde les magasins et on achète des choses, donc les magasins ils gagnent plus d'argent. Et puis il y a moins d'accidents, donc c'est bien aussi. Mais il y a un problème, c'est les gens qui habitent loin. Eux ils ont besoin de la voiture pour venir travailler, et si on enlève la voiture c'est pas bien pour eux. Et aussi les gens qui peuvent pas marcher, les personnes âgées et les personnes handicapées, pour eux c'est un vrai problème. Donc moi je dis oui mais il faut d'abord faire les transports, les bus et les trains, et après on peut enlever les voitures. Voilà, c'est mon avis.",
        1000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous dites qu'il faut d'abord développer les transports en commun. Mais les municipalités répondent que sans contrainte sur la voiture, personne ne changera ses habitudes. La contrainte ne doit-elle pas venir en premier ?",
        420000,
      ),
      entry(
        "debate",
        "candidate",
        "Non, je suis pas d'accord. Parce que si vous enlevez la voiture et qu'il y a pas de bus, les gens ils peuvent plus aller travailler. C'est pas une bonne chose. Il faut d'abord donner la chose qui remplace, et après on enlève. Sinon les gens ils vont être en colère et ils vont voter contre, et après on peut plus rien faire du tout. Donc c'est mieux dans l'autre sens.",
        450000,
      ),
      entry(
        "debate",
        "examiner",
        "Pourtant, à Paris comme à Barcelone, la contrainte est venue d'abord et la fréquentation des transports a suivi. Les faits ne vous donnent pas raison.",
        500000,
      ),
      entry(
        "debate",
        "candidate",
        "Oui mais Paris c'est pas pareil. À Paris il y a déjà beaucoup de métro, beaucoup de bus, il y a déjà tout. Donc quand ils enlèvent la voiture les gens ils prennent le métro et c'est bon. Mais dans une petite ville il y a rien, il y a deux bus par jour, donc c'est pas la même chose du tout. Moi je parle des villes normales, pas des grandes villes qui ont déjà tout.",
        530000,
      ),
      entry(
        "debate",
        "examiner",
        "Et pour les artisans, les livreurs, les personnes à mobilité réduite ? Votre solution les laisse de côté.",
        580000,
      ),
      entry(
        "debate",
        "candidate",
        "Non, pour eux il faut faire une chose spéciale. Ils ont un papier et ils peuvent passer, comme ça ils font leur travail normalement. C'est pas compliqué à faire, ça existe déjà dans des villes. Le problème c'est pas eux, le problème c'est les gens qui prennent la voiture pour faire deux kilomètres alors qu'ils pourraient marcher. C'est ces gens-là qu'il faut changer.",
        610000,
      ),
    ],
  },

  // =====================================================================
  // 5. Rich, fluent French that never realises the task. Extends the
  //    incumbent's `weak-realisation-tache` design into a whole sitting.
  // =====================================================================
  {
    id: "hors-sujet",
    label: "Hors sujet",
    topicSlug: "tourisme-de-masse",
    design:
      "Langue riche, correcte et fluide, mais aucune prise de position : le candidat dérive en anecdotes et en digressions culturelles, et refuse de conclure même relancé. La tâche n'est pas réalisée alors que tous les indices de surface disent « bon candidat ». Étend la conception de la fixture `weak-realisation-tache` de l'implémentation de référence.",
    weakCriterion: "realisationTache",
    monologueSeconds: 395,
    debateSeconds: 640,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Ce document évoque le tourisme de masse, et je dois avouer qu'il réveille immédiatement en moi un souvenir très précis. J'ai passé, adolescent, plusieurs étés chez une grand-tante qui tenait une pension de famille sur la côte, une maison aux volets bleus dont l'escalier craquait de façon reconnaissable entre toutes. Les mêmes familles y revenaient chaque année, et ma grand-tante connaissait le prénom de chaque enfant. C'était un monde d'une douceur remarquable, presque romanesque.",
        1000,
      ),
      entry(
        "monologue",
        "candidate",
        "Cela me conduit naturellement à songer à l'histoire du voyage lui-même, qui est fascinante. Le Grand Tour du dix-huitième siècle, ces jeunes aristocrates anglais parcourant l'Italie carnet à la main, a inventé une manière de regarder le paysage dont nous héritons encore. Puis le chemin de fer a tout bouleversé, et les stations balnéaires ont poussé le long des côtes avec leurs casinos et leurs promenades. Venise, d'ailleurs, était déjà un décor pour Ruskin bien avant de l'être pour les paquebots.",
        180000,
      ),
      entry(
        "monologue",
        "candidate",
        "Et l'on pourrait poursuivre longtemps sur la photographie, qui a transformé le voyage en collection d'images, ou sur la carte postale, objet minuscule et pourtant révélateur d'une époque entière. Je trouve savoureux qu'un texte aussi bref ouvre autant de perspectives. C'est un sujet d'une richesse considérable, sur lequel il y aurait tant à dire.",
        330000,
      ),
      entry(
        "debate",
        "examiner",
        "C'est un exposé cultivé, mais je n'ai pas entendu votre position. Êtes-vous favorable ou non à la limitation du nombre de visiteurs ?",
        420000,
      ),
      entry(
        "debate",
        "candidate",
        "C'est une question redoutable, et je crois honnêtement que chacun peut légitimement avoir son avis. Il y a tant d'aspects à considérer : l'économie locale, la préservation du patrimoine, la liberté de circuler, sans parler de la dimension symbolique de l'accès à la beauté. Ce sont des questions qui méritent d'être méditées longuement.",
        450000,
      ),
      entry(
        "debate",
        "examiner",
        "Je vous demande de trancher. Si vous étiez maire de Venise demain matin, instaureriez-vous un quota, oui ou non ?",
        500000,
      ),
      entry(
        "debate",
        "candidate",
        "Maire de Venise, quelle perspective vertigineuse. Vous savez, Venise est un cas si particulier, cette ville construite sur l'eau, cette lagune fragile dont l'équilibre tient à des siècles d'ingénierie patiente. Je me rappelle avoir lu un ouvrage remarquable sur les fondations de la ville, sur ces pieux de bois enfoncés dans la vase et pétrifiés par l'absence d'oxygène. C'est prodigieux, n'est-ce pas ?",
        530000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous ne répondez pas. Une dernière fois : pour ou contre les quotas ?",
        590000,
      ),
      entry(
        "debate",
        "candidate",
        "Je dirais que la vérité se situe sans doute quelque part entre les deux, comme souvent. C'est un sujet passionnant et je vous remercie de me l'avoir soumis.",
        610000,
      ),
    ],
  },

  // =====================================================================
  // 6. The failure case: a candidate who barely speaks, and a sitting
  //    short enough that the duration rule fires in both systems.
  // =====================================================================
  {
    id: "candidat-quasi-muet",
    label: "Candidat quasi muet",
    topicSlug: "reseaux-sociaux-mineurs",
    design:
      "Le cas dégradé : quelques secondes de parole par tâche, aucun contenu évaluable, et les deux parties sous leur plancher de durée. Sert à comparer le bas de l'échelle, la pénalité de durée et le plancher de compétence à 5/25 — c'est-à-dire les endroits où les deux systèmes calculent au lieu de juger.",
    monologueSeconds: 45,
    debateSeconds: 60,
    transcript: [
      entry(
        "monologue",
        "candidate",
        "Euh… alors… le document il parle des réseaux sociaux. Euh… moi je pense que… euh… c'est compliqué. Voilà.",
        1000,
      ),
      entry(
        "debate",
        "examiner",
        "Vous dites que c'est compliqué. Pourquoi ? Faut-il interdire les réseaux sociaux aux moins de quinze ans ?",
        60000,
      ),
      entry("debate", "candidate", "Euh… je sais pas. Peut-être.", 70000),
      entry(
        "debate",
        "examiner",
        "Essayez de développer : quel argument vous paraît le plus fort, dans un sens ou dans l'autre ?",
        90000,
      ),
      entry("debate", "candidate", "Euh… c'est difficile. Je sais pas.", 100000),
    ],
  },
];

/** Look up a sitting by id, for the `--only` flag. */
export function findSitting(id: string): SittingProfile | undefined {
  return SITTINGS.find((s) => s.id === id);
}

/**
 * A sitting's transcript as the incumbent takes it: a flat `{role, content}[]`
 * for ONE tâche, `assistant` for the examiner and `user` for the candidate.
 *
 * This function is the whole structural departure, in eleven lines. Over there a
 * correction sees one task and a flat list; here a sitting is two tasks and every
 * entry carries its phase. Feeding the incumbent means throwing the phase away —
 * and doing it twice, once per half.
 */
export function asIncumbentMessages(
  sitting: SittingProfile,
  phase: "monologue" | "debate",
): Array<{ role: string; content: string }> {
  return sitting.transcript
    .filter((e) => e.phase === phase)
    .map((e) => ({
      role: e.speaker === "examiner" ? "assistant" : "user",
      content: e.text,
    }));
}
