/**
 * The tableau de bord, as a view model: the tiles, the « Votre trajectoire »
 * chart and the recent-sittings list, computed from rows the database actually
 * holds.
 *
 * PORT NOTE: the reference implementation's dashboard
 * (`/production-orale/tableau-de-bord`) shows four tiles — score moyen, taux de
 * réussite, temps de pratique, série — a « Moyenne par partie » bar chart, and a
 * list of recent submissions. The tiles and the list reproduce directly. The
 * reference's chart never could: it averages a /25 **per DELF partie**, because
 * there a "submission" is one part sat on its own, while this project's sitting
 * is the whole épreuve with one /25 — there is no per-part score to average. A
 * « Moyenne par critère » substitute stood in until #143 replaced it with the
 * trajectory: one bar per simulation on the /25, which answers the question a
 * candidate actually brings here ("am I getting better?") from figures every
 * sitting really has.
 *
 * Pure: the page fetches, this shapes. Unit-tested, so the arithmetic behind a
 * number a candidate reads as their standing is checkable without a database.
 */

import { COMPETENCY_FLOOR, COMPETENCY_MAX } from "@/lib/delf/constants";
import { scoreBand, type ScoreBand } from "@/lib/delf/grille";
import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";
import { formatScore25 } from "@/lib/ui/format-score";

/**
 * How a sitting ended. Only these two reach the candidate's record.
 *
 * A sitting still in progress is neither: it has no score to average and no
 * decision to report, and counting one would mean a candidate's standing
 * changed the moment they opened an épreuve in another tab.
 */
export type SittingOutcome = "corrected" | "abandoned";

/**
 * One sitting on the candidate's record.
 *
 * Two kinds reach it. A **corrected** sitting carries what the rubric returned.
 * An **abandoned** one is a walk-out: the candidate confirmed the exit dialog,
 * having been told in so many words that it would count, so it is scored
 * `0/25` — the same rule as leaving the room on the day.
 *
 * The zero is computed here rather than stored as an evaluation row, and that
 * distinction is load-bearing: no model read an abandoned performance, so there
 * is no correction to write. The score is the *consequence* of an abandonment,
 * not a grading of one, and the criteria are all zero for the same reason
 * they would be on a blank paper.
 */
export interface DashboardSitting {
  examId: number;
  topicSlug: string;
  topicTitle: string;
  outcome: SittingOutcome;
  score25: number;
  meetsFloor: boolean;
  /**
   * `audio` when the recording reached the grader, `text` when it did not, and
   * `null` for an abandoned sitting — which was not graded at all, and would be
   * misreported by either of the other two.
   */
  mode: "text" | "audio" | null;
  criteria: Record<OralCriterion, number>;
  /** Measured audio, summed across the two speaking phases. Never the clock. */
  spokenSeconds: number;
  /** How far the candidate got. `preparation` for a walk-out before speaking. */
  phase: string;
  /** Graded, or walked out of. Newest-first ordering is on this. */
  endedAt: Date;
  /**
   * When a reset took this sitting off the current record (#69), or `null` while
   * it still counts.
   *
   * Nothing in this module reads it, and that is correct: the figures below are
   * computed from the sittings they are given, and whether a sitting counts is
   * decided one layer down, in the query. It travels on the row for the
   * historique, which is handed the archive *and* the record in one list and has
   * to know which is which.
   */
  archivedAt: Date | null;
}

/** The zero an abandoned sitting scores, on every criterion. */
export function zeroCriteria(): Record<OralCriterion, number> {
  return Object.fromEntries(ORAL_CRITERIA.map((key) => [key, 0])) as Record<OralCriterion, number>;
}

export interface DashboardTile {
  key: "moyenne" | "reussite" | "pratique" | "serie";
  label: string;
  value: string;
  /** The one-line gloss under the figure. Never a second copy of the label. */
  caption: string;
  /**
   * Where the figure sits on the /25 scale, when the figure IS a /25.
   *
   * Absent on the other three, and that is the point of it being optional: a
   * percentage, a duration and a day count are not marks, and tinting them on
   * the mark scale would put a 40 % pass rate in the colour of a bad grade.
   * Carried here rather than derived in the component because `value` is already
   * a formatted string by then, and a component parsing it back into a number to
   * colour it is the round trip that eventually disagrees with the figure it
   * colours.
   */
  band?: ScoreBand;
}

/**
 * One simulation on the « Votre trajectoire » chart (#143).
 *
 * Carries its own band so the tooltip's tint and the number it sits on are
 * computed from the same figure in the same place — the rule the tiles already
 * follow. The colour is never the message: the component prints the note as
 * text beside the tint, so a mono printer loses nothing.
 */
export interface TrajectoryPoint {
  examId: number;
  topicTitle: string;
  score25: number;
  band: ScoreBand;
  /** A walk-out is a real bar at 0 — the record the tiles already keep. */
  outcome: SittingOutcome;
  /** « 4 août » — the tooltip's stamp. */
  date: string;
  /** Share of the /25 scale, 0–100, for the bar's height off the floor. */
  percent: number;
}

export interface TrajectoryView {
  /** Oldest first — a trajectory reads left to right. */
  points: TrajectoryPoint[];
  /** The newest simulation, for the card's headline. `null` on an empty record. */
  latest: { score25: number; band: ScoreBand; date: string } | null;
  /**
   * Latest minus the simulation before it, or `null` when there is no before —
   * a delta with one data point would be a comparison against nothing.
   */
  delta: number | null;
}

export interface DashboardView {
  tiles: DashboardTile[];
  trajectory: TrajectoryView;
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
    sittings.map((sitting) => sitting.endedAt),
    today,
  );

  // Named separately, because the average is not "how well you speak French" once
  // a walk-out is in it — it is a record, and the caption has to say so or the
  // number reads as a verdict on the candidate's level.
  const abandoned = sittings.filter((sitting) => sitting.outcome === "abandoned").length;
  const plural = sittings.length > 1 ? "s" : "";

  // The average is a /25, so it is on the /25 scale — including its fractions.
  // `mean` is computed once and the band read off the number, not off the string
  // the tile prints.
  const average = mean(scores);

  return [
    {
      key: "moyenne",
      label: "Note moyenne",
      value: formatScore25(average),
      band: scoreBand(average),
      caption:
        abandoned > 0
          ? `sur ${COMPETENCY_MAX}, ${sittings.length} épreuve${plural} dont ${abandoned} abandonnée${abandoned > 1 ? "s" : ""}`
          : `sur ${COMPETENCY_MAX}, ${sittings.length} épreuve${plural} corrigée${plural}`,
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
 * The chart's y-gridlines: 0 · 5 · 10 · 15 · 20 · 25, derived from the /25 so
 * a scale that ever moved would move its ruler with it.
 */
export const TRAJECTORY_TICKS: readonly number[] = Array.from(
  { length: COMPETENCY_MAX / 5 + 1 },
  (_, index) => index * 5,
);

/**
 * « +6 pts » / « −2 pts » / « ±0 pt » — the headline's movement since the
 * previous simulation. The sign is always printed: a bare « 6 pts » does not
 * say which way the trajectory went, and that direction is the figure's job.
 */
export function formatScoreDelta(delta: number): string {
  const magnitude = Math.abs(delta);
  const unit = magnitude > 1 ? "pts" : "pt";
  if (delta > 0) return `+${magnitude} ${unit}`;
  if (delta < 0) return `−${magnitude} ${unit}`;
  return `±0 pt`;
}

/**
 * The trajectory: every sitting on the record, oldest first, as a bar on the
 * /25 scale.
 *
 * Its own ordering rather than a reuse of `recent` — the recent list is
 * newest-first and trimmed, and a trajectory that silently stopped at five
 * bars would draw a record the tiles contradict.
 */
function buildTrajectory(newestFirst: readonly DashboardSitting[]): TrajectoryView {
  const chronological = [...newestFirst].reverse();

  const points = chronological.map((sitting): TrajectoryPoint => {
    return {
      examId: sitting.examId,
      topicTitle: sitting.topicTitle,
      score25: sitting.score25,
      band: scoreBand(sitting.score25),
      outcome: sitting.outcome,
      date: formatSittingDate(sitting.endedAt),
      percent: (sitting.score25 / COMPETENCY_MAX) * 100,
    };
  });

  const latest = points.at(-1);
  const previous = points.at(-2);

  return {
    points,
    latest: latest ? { score25: latest.score25, band: latest.band, date: latest.date } : null,
    delta: latest && previous ? latest.score25 - previous.score25 : null,
  };
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
  const ordered = [...sittings].sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());

  return {
    tiles: buildTiles(ordered, today),
    trajectory: buildTrajectory(ordered),
    recent: ordered.slice(0, RECENT_LIMIT),
    count: ordered.length,
  };
}

/** "16 août" — a sitting's date, in the list. */
export function formatSittingDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}

/** "16 août 2026, 14:32" — the historique's fuller stamp. */
export function formatSittingDateTime(date: Date): string {
  return date.toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What happened to a sitting, in the candidate's words, for the historique.
 *
 * An abandonment names the phase it was abandoned in, because "abandonnée" on
 * its own invites the reading that the product lost the épreuve. Naming the
 * moment — during the préparation, during the monologue — makes it a record of
 * something the candidate did.
 */
export function describeOutcome(sitting: DashboardSitting): string {
  if (sitting.outcome === "corrected") {
    return sitting.mode === "text"
      ? "Corrigée sans l'audio, sur la transcription seule"
      : "Corrigée sur l'audio et la transcription";
  }

  switch (sitting.phase) {
    case "preparation":
      return "Abandonnée pendant la préparation, avant toute prise de parole";
    case "monologue":
      return "Abandonnée pendant le monologue";
    case "debate":
      return "Abandonnée pendant le débat";
    default:
      return "Abandonnée avant la correction";
  }
}
