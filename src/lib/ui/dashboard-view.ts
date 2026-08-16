/**
 * The tableau de bord, as a view model: the tiles, the per-criterion bars and
 * the recent-sittings list, computed from rows the database actually holds.
 *
 * PORT NOTE: the reference implementation's dashboard
 * (`/production-orale/tableau-de-bord`) shows four tiles — score moyen, taux de
 * réussite, temps de pratique, série — a « Moyenne par partie » bar chart, and a
 * list of recent submissions. The tiles and the list reproduce directly. The bar
 * chart does not, and the substitution is the one interesting decision here:
 *
 * The reference's chart averages a /25 **per DELF partie**, because there a
 * "submission" is one part sat on its own — a candidate picks partie 1 or partie
 * 2 from the catalogue and gets a score for it. This project's sitting is the
 * whole épreuve: one monologue *and* one débat, one correction, one /25. There
 * is no per-part score to average, and inventing one by splitting a single /25
 * across two parts would be exactly the "computing data the earlier phase does
 * not produce" that #11 rules out.
 *
 * What this project does have, and the reference did not expose, is the five
 * criteria as five real columns on `evaluations`. So the chart keeps its shape —
 * labelled rows, a bar each, a count beside them — and changes its axis to
 * **moyenne par critère**. Same question answered ("where am I losing points?"),
 * better answered, and every number in it comes off a column.
 *
 * Pure: the page fetches, this shapes. Unit-tested, so the arithmetic behind a
 * number a candidate reads as their standing is checkable without a database.
 */

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import { GRILLE_BANDS } from "@/lib/delf/grille";
import { ORAL_CRITERIA, ORAL_CRITERIA_LABELS, type OralCriterion } from "@/lib/delf/criteria";

/**
 * The top of the grille's scale, for the bars' full width.
 *
 * Derived here rather than added to `grille.ts`: that file is a byte-for-byte
 * port of the reference's own grille and carries an explicit instruction not to
 * grow it. Reading the last band off `GRILLE_BANDS` is the same single source of
 * truth without editing the file — and it is still not the literal `5`, so a
 * grille whose top band ever moved would move this with it.
 */
const GRILLE_MAX_BAND = GRILLE_BANDS[GRILLE_BANDS.length - 1];

/**
 * One corrected sitting, as the dashboard needs it.
 *
 * Only corrected sittings appear: a sitting with no correction has no score, no
 * criteria and — since `spoken_seconds` is written by the finish route — no
 * measured practice time either. Counting abandoned attempts in a "score moyen"
 * would drag it toward zero for a reason that is not about the candidate's
 * French.
 */
export interface DashboardSitting {
  examId: number;
  topicSlug: string;
  topicTitle: string;
  score25: number;
  meetsFloor: boolean;
  /** `audio` when the recording reached the grader, `text` when it did not. */
  mode: "text" | "audio";
  criteria: Record<OralCriterion, number>;
  /** Measured audio, summed across the two speaking phases. Never the clock. */
  spokenSeconds: number;
  finishedAt: Date;
}

export interface DashboardTile {
  key: "moyenne" | "reussite" | "pratique" | "serie";
  label: string;
  value: string;
  /** The one-line gloss under the figure. Never a second copy of the label. */
  caption: string;
}

export interface CriterionAverage {
  key: OralCriterion;
  label: string;
  /** Mean band on the grille's own 0–5 scale, to one decimal. */
  average: number;
  /** Share of the scale, for the bar's width. 0–100. */
  percent: number;
}

export interface DashboardView {
  tiles: DashboardTile[];
  criteria: CriterionAverage[];
  /** Newest first, already trimmed to what the card shows. */
  recent: DashboardSitting[];
  /** How many corrected sittings the figures were computed from. */
  count: number;
}

/** How many sittings the "dernières épreuves" card lists. */
export const RECENT_LIMIT = 5;

/** Mean, to one decimal, of a list that may be empty. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

/**
 * `1 h 05` / `48 min` / `40 s` — practice time, in the largest unit that does
 * not lie.
 *
 * Minutes are zero-padded inside an hour so "1 h 05" cannot be misread as
 * "1 h 50", and a sitting under a minute is reported in seconds rather than
 * rounded to "0 min", which is what a candidate who has just recorded forty
 * seconds would otherwise be shown.
 */
export function formatPracticeTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (safe < 60) return `${safe} s`;

  const totalMinutes = Math.floor(safe / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${minutes.toString().padStart(2, "0")}`;
}

/**
 * Consecutive days ending today or yesterday, counted from the sitting dates.
 *
 * Two properties, both of them the difference between a streak a candidate
 * trusts and one they argue with:
 *
 *  - **It ends yesterday, not only today.** A streak that resets at midnight
 *    tells someone who practised every day for a week and has not yet opened
 *    the app this morning that they are on zero. Yesterday still counts; the
 *    day before does not.
 *  - **Days are compared in local time.** The rows are UTC timestamps, and a
 *    candidate sitting an épreuve at 23:00 in Paris is on a different UTC date
 *    from the one their calendar shows. `toDateString()` is the browser's and
 *    the server's own local day, which is the day the candidate means.
 *
 * `today` is a parameter so the function is testable without freezing a clock —
 * the caller passes `new Date()`.
 */
export function currentStreak(dates: readonly Date[], today: Date): number {
  if (dates.length === 0) return 0;

  const days = new Set(dates.map((date) => date.toDateString()));

  const cursor = new Date(today);
  // Start on today if it was practised, otherwise on yesterday — beyond that
  // the streak is broken and there is nothing to count.
  if (!days.has(cursor.toDateString())) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(cursor.toDateString())) return 0;
  }

  let streak = 0;
  while (days.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * The four tiles.
 *
 * The captions carry the unit and the rule — « sur 25 », « seuil 5/25 » — so a
 * figure never stands alone. That is the same requirement the grille is built
 * under: a number a candidate cannot situate is a number they will situate
 * wrongly.
 */
function buildTiles(sittings: readonly DashboardSitting[], today: Date): DashboardTile[] {
  const scores = sittings.map((sitting) => sitting.score25);
  const passed = sittings.filter((sitting) => sitting.meetsFloor).length;
  const practice = sittings.reduce((total, sitting) => total + sitting.spokenSeconds, 0);
  const streak = currentStreak(
    sittings.map((sitting) => sitting.finishedAt),
    today,
  );

  return [
    {
      key: "moyenne",
      label: "Note moyenne",
      value: `${mean(scores)}`,
      caption: `sur ${COMPETENCY_MAX}, ${sittings.length} épreuve${sittings.length > 1 ? "s" : ""} corrigée${sittings.length > 1 ? "s" : ""}`,
    },
    {
      key: "reussite",
      label: "Au-dessus du seuil",
      value: `${sittings.length === 0 ? 0 : Math.round((passed / sittings.length) * 100)} %`,
      caption: `seuil éliminatoire de ${COMPETENCY_FLOOR}/${COMPETENCY_MAX}`,
    },
    {
      key: "pratique",
      label: "Temps de parole",
      value: formatPracticeTime(practice),
      // Named as measured audio, not as time spent on the site: the two differ
      // whenever a microphone failed, and this product knows the difference.
      caption: "enregistré, hors préparation",
    },
    {
      key: "serie",
      label: "Série",
      value: `${streak} j`,
      caption: streak > 0 ? "jours consécutifs" : "reprenez quand vous voulez",
    },
  ];
}

/**
 * The per-criterion averages, in the grille's own order.
 *
 * Built from `ORAL_CRITERIA` rather than from the keys present on the rows, so a
 * criterion that no correction happened to score still gets a row at zero
 * instead of silently disappearing from the chart.
 */
function buildCriteriaAverages(sittings: readonly DashboardSitting[]): CriterionAverage[] {
  return ORAL_CRITERIA.map((key) => {
    const average = mean(sittings.map((sitting) => sitting.criteria[key] ?? 0));
    return {
      key,
      label: ORAL_CRITERIA_LABELS[key],
      average,
      percent: Math.round((average / GRILLE_MAX_BAND) * 100),
    };
  });
}

/**
 * Assemble the dashboard.
 *
 * `sittings` may arrive in any order; this sorts newest-first itself rather than
 * trusting the query, because the recent list and the streak both depend on it
 * and a page that got the order from one place and the arithmetic from another
 * is the kind of thing that only breaks when somebody adds an index.
 */
export function buildDashboardView(
  sittings: readonly DashboardSitting[],
  today: Date,
): DashboardView {
  const ordered = [...sittings].sort(
    (a, b) => b.finishedAt.getTime() - a.finishedAt.getTime(),
  );

  return {
    tiles: buildTiles(ordered, today),
    criteria: buildCriteriaAverages(ordered),
    recent: ordered.slice(0, RECENT_LIMIT),
    count: ordered.length,
  };
}

/** "16 août" — a sitting's date, in the list. */
export function formatSittingDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}
