import type { OralPhase } from "@/lib/delf/phases";

/**
 * What « Retour » costs, and therefore which confirmation it opens (#199).
 *
 * One decision, in one place, because it used to be two conditions in two files
 * that disagreed. `ExamClient` chose its dialog on the **phase** alone: the
 * préparation got the one that promises no zero, everything after it got the one
 * that promises 0/25. But a speaking part opens *armed* — the consigne is
 * spoken, the control reads « Enregistrer », no clock is running and nothing is
 * being captured — and for that whole window the phase already said "monologue"
 * or "debate". A candidate who left there was warned of a zero, and the walk-out
 * was written, for a performance that did not exist.
 *
 * The rule the phase could not express: **the zero is owed from « Enregistrer »,
 * never before it.** So the answer is a function of the phase AND whether the
 * part has begun, and what a part that has not begun costs depends on what came
 * before it — which is the whole reason there are three answers and not two.
 */
export type ExamExitRoute =
  /**
   * Nothing has been said: the préparation, or a monologue still waiting on
   * « Enregistrer ». There is no performance to score, so the sitting is
   * archived (#113) and reaches no historique, no sujet card and no moyenne.
   */
  | "archive"
  /**
   * The exposé is spoken and the débat has not begun. Something was produced,
   * so leaving is not an absence of a record — it is the sitting ending one
   * part early. The prestation goes for correction with the débat unspoken,
   * which the rubric already prices: `partsAbsent` counts words, a débat with
   * none is an absent part, and `applyAbsentPartPenalty` halves the /25.
   */
  | "finish"
  /**
   * A part is running. This is the walk-out the exit dialog has always been
   * about, and its zero is a promise `abandoned_at` keeps.
   */
  | "abandon";

/**
 * Which of the three a candidate is looking at.
 *
 * `awaitingStart` is the controller's own `phaseAwaitingStart` — "this part's
 * clock has not been anchored" — and is meaningless off a speaking phase, which
 * is why the préparation is answered before it is consulted rather than by it.
 *
 * `finished` cannot reach here: the finished screen has no exit dialog, it has a
 * way out that is not a decision. It answers `abandon` anyway rather than
 * throwing, because the one thing this must never do is fail open into a
 * silent exit — a route this function cannot name should still be the one that
 * writes the sitting down.
 */
export function examExitRoute(phase: OralPhase, awaitingStart: boolean): ExamExitRoute {
  if (phase === "preparation") return "archive";
  if (phase === "monologue") return awaitingStart ? "archive" : "abandon";
  if (phase === "debate") return awaitingStart ? "finish" : "abandon";
  return "abandon";
}
