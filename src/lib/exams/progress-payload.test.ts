import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_PHASE_SECONDS, MAX_TURNS, MAX_TURN_CHARS } from "./finish-payload";
import { progressPayloadSchema } from "./progress-payload";

const STARTED = Date.UTC(2026, 7, 15, 10, 0, 0);
const ENDED = Date.UTC(2026, 7, 15, 10, 7, 0);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    phase: "monologue",
    entries: [
      {
        phase: "monologue",
        speaker: "candidate",
        timestamp: 1_000,
        text: "Je défendrai l'idée que le télétravail est un progrès.",
      },
    ],
    startedAt: STARTED,
    endedAt: ENDED,
    ...overrides,
  };
}

describe("progress payload", () => {
  it("accepts a finalised monologue", () => {
    const parsed = progressPayloadSchema.safeParse(payload());
    assert.equal(parsed.success, true);
  });

  it("accepts a phase that produced no turns", () => {
    // A candidate who sat in silence still finished the phase, and the record
    // that they entered it is worth more than the empty array costs.
    assert.equal(progressPayloadSchema.safeParse(payload({ entries: [] })).success, true);
  });

  it("refuses turns belonging to another phase", () => {
    // Otherwise a payload claiming the monologue finalised could file débat
    // turns under it, and the evaluator grades the two tasks separately.
    const parsed = progressPayloadSchema.safeParse(
      payload({
        entries: [{ phase: "debate", speaker: "candidate", timestamp: 1, text: "Je maintiens." }],
      }),
    );
    assert.equal(parsed.success, false);
  });

  it("refuses a phase that ended before it started", () => {
    assert.equal(
      progressPayloadSchema.safeParse(payload({ startedAt: ENDED, endedAt: STARTED })).success,
      false,
    );
  });

  it("refuses a phase longer than any real épreuve", () => {
    assert.equal(
      progressPayloadSchema.safeParse(
        payload({ startedAt: 0, endedAt: (MAX_PHASE_SECONDS + 1) * 1000 }),
      ).success,
      false,
    );
  });

  it("requires an end — a phase reports itself because it ended", () => {
    assert.equal(progressPayloadSchema.safeParse(payload({ endedAt: null })).success, false);
  });

  it("refuses an unknown phase", () => {
    assert.equal(progressPayloadSchema.safeParse(payload({ phase: "preparation" })).success, false);
  });

  it("bounds the turns exactly as the finish payload does", () => {
    // Same column, same numbers. Two copies of these bounds would be two copies
    // that drift, which is why `transcript-payload.ts` exists.
    const longTurn = payload({
      entries: [
        {
          phase: "monologue",
          speaker: "candidate",
          timestamp: 0,
          text: "a".repeat(MAX_TURN_CHARS + 1),
        },
      ],
    });
    assert.equal(progressPayloadSchema.safeParse(longTurn).success, false);

    const tooManyTurns = payload({
      entries: Array.from({ length: MAX_TURNS + 1 }, (_, i) => ({
        phase: "monologue",
        speaker: "candidate",
        timestamp: i,
        text: "oui",
      })),
    });
    assert.equal(progressPayloadSchema.safeParse(tooManyTurns).success, false);
  });

  it("refuses a body that is not an object at all", () => {
    assert.equal(progressPayloadSchema.safeParse(null).success, false);
    assert.equal(progressPayloadSchema.safeParse("monologue").success, false);
  });
});
