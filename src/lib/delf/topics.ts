/**
 * DELF B2 production orale subjects.
 *
 * A B2 subject is a short "document déclencheur" (a press extract or a factual
 * statement) that the candidate must react to: dégager le thème, prendre
 * position, défendre. These are written for this project rather than copied from
 * the reference repo's `data/` corpus, which is scraped exam content that does
 * not belong to this codebase.
 *
 * Seeded into the database on first run; the catalogue lives here so the app has
 * something to run against with an empty database.
 */

export interface OralTopic {
  slug: string;
  title: string;
  /** The trigger document the candidate reads during preparation. */
  document: string;
  /** The instruction: what the candidate must actually do with it. */
  consigne: string;
}

const DEFAULT_CONSIGNE =
  "Dégagez le thème soulevé par ce document, puis présentez votre opinion sous la forme d'un exposé construit et argumenté d'environ 5 à 7 minutes. Vous défendrez ensuite votre position dans un débat avec l'examinateur.";

export const ORAL_TOPICS: readonly OralTopic[] = [
  {
    slug: "teletravail",
    title: "Le télétravail a-t-il vraiment amélioré nos vies ?",
    document:
      "Cinq ans après sa généralisation, le télétravail s'est installé dans le quotidien de millions de salariés. Ses partisans y voient une liberté retrouvée : moins de transports, plus de temps pour soi, une productivité accrue. Ses détracteurs alertent sur l'effacement de la frontière entre vie professionnelle et vie privée, l'isolement des plus jeunes et l'affaiblissement du collectif de travail. Plusieurs grandes entreprises sont récemment revenues sur leurs accords et imposent de nouveau une présence sur site.",
    consigne: DEFAULT_CONSIGNE,
  },
  {
    slug: "ia-education",
    title: "Faut-il encadrer l'intelligence artificielle à l'école ?",
    document:
      "Les élèves utilisent désormais massivement des assistants conversationnels pour rédiger leurs devoirs. Certains établissements y voient un outil pédagogique à intégrer, capable d'aider chaque élève à son rythme. D'autres ont choisi l'interdiction pure et simple, estimant que la rédaction et l'effort de recherche sont précisément ce que l'école doit enseigner. Les enseignants, eux, se disent démunis face à des copies qu'ils ne peuvent plus attribuer avec certitude.",
    consigne: DEFAULT_CONSIGNE,
  },
  {
    slug: "villes-sans-voiture",
    title: "Faut-il bannir la voiture des centres-villes ?",
    document:
      "De plus en plus de municipalités européennes ferment leur centre à la circulation automobile, au profit des piétons, des vélos et des transports en commun. Les résultats affichés sont encourageants : air plus respirable, commerces de proximité redynamisés, accidents en baisse. Mais les habitants des périphéries, les artisans et les personnes à mobilité réduite dénoncent une mesure pensée par et pour les centres-villes aisés, qui les exclut un peu plus.",
    consigne: DEFAULT_CONSIGNE,
  },
  {
    slug: "reseaux-sociaux-mineurs",
    title: "Faut-il interdire les réseaux sociaux aux moins de quinze ans ?",
    document:
      "Plusieurs pays ont voté une interdiction des réseaux sociaux pour les mineurs de moins de quinze ans, invoquant la santé mentale des adolescents, le harcèlement en ligne et l'exposition à des contenus violents. Les opposants à ces lois soulignent l'inefficacité technique de tels contrôles, le risque de couper les jeunes d'un espace de socialisation réel, et rappellent que la responsabilité éducative revient d'abord aux familles.",
    consigne: DEFAULT_CONSIGNE,
  },
  {
    slug: "semaine-quatre-jours",
    title: "La semaine de quatre jours est-elle un progrès ?",
    document:
      "Des entreprises de plusieurs pays ont expérimenté la semaine de quatre jours sans baisse de salaire. Les bilans publiés font état d'une satisfaction accrue des salariés, d'un absentéisme en recul et d'une productivité stable. Les réserves portent sur la transposition du modèle : dans l'hôpital, le commerce ou l'industrie, réduire les jours travaillés suppose d'embaucher, ce que peu d'employeurs envisagent. Certains salariés décrivent aussi des journées devenues plus denses et plus épuisantes.",
    consigne: DEFAULT_CONSIGNE,
  },
  {
    slug: "tourisme-de-masse",
    title: "Le tourisme de masse doit-il être limité ?",
    document:
      "Venise, Barcelone et plusieurs sites naturels ont instauré des quotas de visiteurs, une taxe de séjour renforcée ou une réservation obligatoire. Les habitants dénoncent des logements accaparés par la location saisonnière et des centres historiques devenus décors. Le secteur touristique rappelle qu'il fait vivre des régions entières et s'inquiète d'un accès aux plus beaux sites réservé à ceux qui peuvent en payer le prix.",
    consigne: DEFAULT_CONSIGNE,
  },
];

export function findTopic(slug: string): OralTopic | undefined {
  return ORAL_TOPICS.find((t) => t.slug === slug);
}
