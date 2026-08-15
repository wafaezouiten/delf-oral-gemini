/**
 * What the corrector is allowed to return, and what happens when it does not.
 *
 * Extracted from `evaluate.ts` for the reason `finish-payload.ts` was extracted
 * from the finish route: `evaluate.ts` imports `server-only` and cannot be
 * loaded by `node --test`, which would leave the code that decides whether a
 * model's answer is trustworthy as the one thing in the grading path with no
 * coverage.
 *
 * **Why this exists at all.** The evaluator used to read the model's reply with
 * `Number(entry?.score ?? 0)`. A response missing `phonologie` — a truncated
 * generation, a refusal, a schema the model quietly ignored — therefore scored
 * that criterion 0 and carried on, and a candidate lost five points to a
 * malformed JSON object that nobody was told about. Every failure mode of a
 * language model looks like a plausible object with something missing from it,
 * so the contract is checked rather than assumed, and a breach throws (#9).
 *
 * **What is checked, and what is not.** The five bands decide the mark, so they
 * are required, finite, and inside the grille's range. `total25` is the model's
 * own arithmetic, kept only so a model that adds up wrong can be noticed — it
 * decides nothing, so it is not allowed to fail an otherwise good correction.
 *
 * Note what is deliberately NOT rejected: a score of 2 or 4. The grille has no
 * such band and the prompt says so, but `snapToBand` is the ported net under
 * exactly that mistake, and failing the whole sitting because a model reached
 * for a 4 would throw away a correction the rubric knows how to read.
 */

import { z } from "zod";

import { ORAL_CRITERIA, type OralCriterion } from "@/lib/delf/criteria";

/** The widest score the grille could mean. Anything outside is not a band the
 *  snapper can rescue, it is a model that has stopped following the contract. */
const MIN_SCORE = 0;
const MAX_SCORE = 5;

const criterionSchema = z.object({
  score: z.number().min(MIN_SCORE).max(MAX_SCORE),
  /** May be empty — a thin justification is a weak correction, not a broken
   *  one, and the mark does not depend on it. */
  justification: z.string(),
});

/**
 * The five criteria, written out rather than generated from `ORAL_CRITERIA`,
 * because a schema built by `Object.fromEntries` types as an index signature and
 * gives back `unknown` for every field it validated.
 *
 * `satisfies` is what keeps the two in step: adding a criterion to the grille
 * without adding it here, or misspelling one, is a compile error rather than a
 * criterion that silently stops being required of the model.
 */
const criterionShape = {
  realisationTache: criterionSchema,
  interaction: criterionSchema,
  lexique: criterionSchema,
  morphosyntaxe: criterionSchema,
  phonologie: criterionSchema,
} satisfies Record<OralCriterion, typeof criterionSchema>;

export const evaluationResponseSchema = z.object({
  ...criterionShape,
  /** The model's own total. Recomputed by the rubric and never used as the mark. */
  total25: z.number(),
  phonologieNonEvaluable: z.boolean(),
  appreciationGlobale: z.string(),
  pointsForts: z.array(z.string()),
  axesPrioritaires: z.array(z.string()),
  conseil: z.string(),
});

export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>;

/**
 * Read the corrector's reply, or refuse it.
 *
 * Throws on anything that is not a complete, in-range correction. That is the
 * whole point: the alternative to a visible failure here is an invisible one on
 * a candidate's results page, and the caller can retry a throw.
 *
 * The message carries the first breach and a slice of what arrived, because the
 * two questions on a failed run are always "what was wrong" and "what did it
 * actually say".
 */
export function parseEvaluationResponse(text: string): EvaluationResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`The evaluator returned invalid JSON: ${preview(text)}`);
  }

  const parsed = evaluationResponseSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    throw new Error(
      `The evaluator returned an unusable correction: ${where} ${first?.message ?? "is invalid"} — ${preview(text)}`,
    );
  }

  return parsed.data;
}

/** Enough of a reply to recognise it in a log, not enough to fill one. */
function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/** The five scores, keyed by criterion — the only part of the reply that
 *  becomes a mark. Raw: snapping them onto bands is the rubric's job. */
export function criterionScores(response: EvaluationResponse): Record<OralCriterion, number> {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, response[criterion].score]),
  ) as Record<OralCriterion, number>;
}

/** The five justifications, same shape. */
export function criterionJustifications(
  response: EvaluationResponse,
): Record<OralCriterion, string> {
  return Object.fromEntries(
    ORAL_CRITERIA.map((criterion) => [criterion, response[criterion].justification]),
  ) as Record<OralCriterion, string>;
}
