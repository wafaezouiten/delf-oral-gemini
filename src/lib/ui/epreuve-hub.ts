/**
 * The Production orale hub, as a view model: every string the landing page
 * prints, derived from the épreuve's own constants and testable without a
 * browser, a database or a Clerk session.
 *
 * PORT NOTE: this is `src/lib/epreuve-hub.ts` from the reference implementation,
 * narrowed from two épreuves at four levels to one épreuve at one level. The
 * reference's whole design — a view model so the hub components never branch on
 * which épreuve they draw — exists because it renders `/production-ecrite` and
 * `/production-orale` from one set of components. There is no écrite here, so
 * `ProductionEpreuve`, `ECRITE_TASKS_BY_LEVEL` and the `epreuve === "ecrite"`
 * branches are dropped rather than kept with one caller.
 *
 * What is deliberately kept is the *shape*: the page's copy stays out of the
 * route file, the format rows are read off `ORAL_PARTS_B2` rather than retyped,
 * and the components stay dumb. That is what makes the format section correct by
 * construction — if the B2 débat's duration changes in `constants.ts`, the chip
 * on the hub changes with it.
 */

import { COMPETENCY_FLOOR, COMPETENCY_MAX, ORAL_PARTS_B2 } from "@/lib/delf/constants";
import { ORAL_CRITERIA, ORAL_CRITERIA_LABELS } from "@/lib/delf/criteria";
import { PHASE_DURATIONS } from "@/lib/delf/phases";

/** One row of « Le format de l'épreuve »: a partie, flattened for the card. */
export interface HubFormatItem {
  /** Stable key, and the pill's text. */
  key: string;
  pill: string;
  title: string;
  description: string;
  /** The neutral chips under the description: duration, preparation, marking. */
  facts: string[];
}

/** The three-up strip that closes the hub. */
export interface HubCapability {
  /** Named by role, resolved to a glyph in the component — never an icon here. */
  icon: "conditions" | "correction" | "score";
  title: string;
  description: string;
}

export interface HubLinks {
  sujets: string;
  tableauDeBord: string;
}

/** The whole hub, ready to render. */
export interface HubView {
  /** The serif headline. */
  title: string;
  lead: string;
  /** "DELF B2 · 2 parties · noté /25" — the masthead pill. */
  shapePill: string;
  format: HubFormatItem[];
  capabilities: HubCapability[];
  /** The grille's five criteria, as the examiner marks them. */
  criteria: string[];
  links: HubLinks;
}

/** Whole minutes, for a chip. The épreuve's constants are all in seconds. */
function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * The format rows.
 *
 * The preparation fact comes from `PHASE_DURATIONS` rather than from the part
 * spec's own `preparationSeconds`, and the difference matters for exactly one
 * row: the débat's spec says zero, which is true of the DELF (there is no second
 * préparation) and would print « Sans préparation » — accurate, but read on the
 * hub as though the débat were an unprepared task. It is not: it is the second
 * half of a sitting whose preparation happened once, at the start. So the chip
 * is only printed where there is a preparation to name.
 */
export function buildHubFormat(): HubFormatItem[] {
  return ORAL_PARTS_B2.map((spec) => ({
    key: `partie-${spec.tache}`,
    pill: `Partie ${spec.tache}`,
    title: spec.title,
    description: spec.description,
    facts: [
      `≈ ${minutes(spec.durationSeconds)} min`,
      ...(spec.preparationSeconds > 0
        ? [`Préparation : ${minutes(spec.preparationSeconds)} min`]
        : []),
      `noté /${COMPETENCY_MAX}`,
    ],
  }));
}

/** French pluralisation for the small counts this module deals in. */
function plural(n: number, one: string, many: string): string {
  return n > 1 ? many : one;
}

/** "DELF B2 · 2 parties · noté /25". */
export function buildShapePill(): string {
  const count = ORAL_PARTS_B2.length;
  return `DELF B2 · ${count} ${plural(count, "partie", "parties")} · noté /${COMPETENCY_MAX}`;
}

const CAPABILITIES: HubCapability[] = [
  {
    icon: "conditions",
    title: "Examinateur IA",
    description: `${minutes(PHASE_DURATIONS.preparation)} minutes de préparation, puis un oral dans les conditions du DELF.`,
  },
  {
    icon: "correction",
    title: "Transcription et correction",
    description:
      "Votre production est enregistrée et transcrite, puis évaluée sur la grille officielle.",
  },
  {
    icon: "score",
    title: `Note /${COMPETENCY_MAX}`,
    description: `Seuil de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX} à atteindre, critère par critère et commentaires détaillés.`,
  },
];

/**
 * The criteria the hub states.
 *
 * Read off `ORAL_CRITERIA_LABELS` rather than retyped as the reference does it:
 * these are the same five headings the grille prints on the correction, and a
 * hub that promised a sixth — or spelled one differently — would be advertising
 * an épreuve this product does not mark.
 */
export function buildHubCriteria(): string[] {
  return ORAL_CRITERIA.map((criterion) => ORAL_CRITERIA_LABELS[criterion]);
}

export const HUB_LINKS: HubLinks = {
  sujets: "/app/sujets",
  tableauDeBord: "/app/tableau-de-bord",
};

/**
 * Whether a navigation link is the one the candidate is currently on.
 *
 * Two rules, because the rail holds two kinds of link and one rule cannot serve
 * both:
 *
 *  - **A section link matches its own subtree.** `/app/sujets` stays lit while
 *    the candidate is on `/app/sujets/whatever`, which is what a section means.
 *  - **An index link matches only itself** (`exact`). The hub's href is `/app`,
 *    and every route in the product is under it — so the subtree rule lights
 *    "L'épreuve" on the sujets page, the dashboard, the simulateur and the
 *    correction all at once, and the rail claims the candidate is somewhere they
 *    are not. The reference hits the same thing and solves it the same way: its
 *    `DASHBOARD_ITEM` is compared with `===` while its épreuve groups use a
 *    prefix.
 *
 * Note the prefix is `${href}/` and not `href`: a bare `startsWith` would also
 * match `/app/sujets-archive`, which shares the string but is not under the
 * route.
 *
 * Here rather than in the component because it is a rule with two edges, and
 * this is where rules with edges get a test in this repo.
 */
export function isNavLinkActive(pathname: string, href: string, exact = false): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function buildHubView(): HubView {
  return {
    title: "Production orale.",
    lead: "Simulateur avec examinateur IA, enregistrement de vos deux prises de parole, et correction sur 25 selon la grille officielle du DELF B2.",
    shapePill: buildShapePill(),
    format: buildHubFormat(),
    capabilities: CAPABILITIES,
    criteria: buildHubCriteria(),
    links: HUB_LINKS,
  };
}

// =====================================================
// THE SUJET CARDS
// =====================================================

/** One sujet card, on the hub's row and in the kiosk's grid. */
export interface HubSujet {
  slug: string;
  title: string;
  /** The neutral pill: what the sujet asks you to produce. */
  kind: string;
  /** The card's first paragraph, cut to a teaser. */
  teaser: string;
  /** "30 min de préparation · 20 min d'oral". */
  meta: string;
  /** The candidate's best /25 on this sujet, or null if never sat. */
  score: number | null;
}

/**
 * A sujet's teaser: the document's opening, cut at a sentence boundary.
 *
 * Cut at a sentence rather than at a character count with an ellipsis, because
 * the documents déclencheurs are press extracts written in whole sentences and a
 * card that ends mid-clause reads as broken markup rather than as a preview.
 * Falls back to a hard cut only for a document with no sentence end in range,
 * which the seeded catalogue does not contain but a future one might.
 */
export function sujetTeaser(document: string, maxChars = 180): string {
  const text = document.trim();
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);
  const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" ! "), window.lastIndexOf(" ? "));
  if (lastStop > maxChars * 0.4) return window.slice(0, lastStop + 1).trim();

  const lastSpace = window.lastIndexOf(" ");
  return `${window.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

/** "30 min de préparation · 20 min d'oral" — the card's foot. */
export function sujetMeta(): string {
  const prep = minutes(PHASE_DURATIONS.preparation);
  const oral = minutes(PHASE_DURATIONS.monologue + PHASE_DURATIONS.debate);
  return `${prep} min de préparation · ${oral} min d'oral`;
}

/**
 * The sujet cards, from the catalogue and whatever the candidate has scored.
 *
 * The scores are passed in rather than fetched, so this stays pure and the page
 * decides how much of the history it wants to pay for. A slug with no entry is
 * `null`, which is what makes the card read "Commencer" rather than "Refaire" —
 * and the distinction is why the map is passed at all rather than defaulted to
 * zero, which would claim every unsat sujet had been failed.
 */
export function buildHubSujets(
  topics: ReadonlyArray<{ slug: string; title: string; document: string }>,
  bestScores: ReadonlyMap<string, number>,
): HubSujet[] {
  return topics.map((topic) => ({
    slug: topic.slug,
    title: topic.title,
    kind: "Monologue et débat",
    teaser: sujetTeaser(topic.document),
    meta: sujetMeta(),
    score: bestScores.get(topic.slug) ?? null,
  }));
}
