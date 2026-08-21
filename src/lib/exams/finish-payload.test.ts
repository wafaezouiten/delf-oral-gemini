import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PHASE_SECONDS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TURNS,
  MAX_TURN_CHARS,
  finishPayloadSchema,
} from "./finish-payload";

/**
 * The finish route's trust boundary.
 *
 * Everything here is about a request nobody in this codebase writes: the browser
 * always sends a well-formed payload, so every assertion below describes a
 * hand-crafted one. That is the point — the route is authenticated but the
 * caller is the graded party, and validation is what stands between them and
 * either the server's memory or their own mark.
 */

/** A payload the real client would send, with one field overridden. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    topicSlug: "teletravail",
    transcript: [
      { phase: "monologue", speaker: "candidate", timestamp: 1000, text: "Mon exposé." },
      { phase: "debate", speaker: "examiner", timestamp: 2000, text: "Une objection." },
    ],
    phases: [
      { phase: "monologue", elapsedSeconds: 400, startedAt: 1_000_000, endedAt: 1_400_000 },
      { phase: "debate", elapsedSeconds: 780, startedAt: 1_400_000, endedAt: 2_180_000 },
    ],
    reconnectCount: 1,
    ...overrides,
  };
}

const accepts = (input: unknown) => finishPayloadSchema.safeParse(input).success;

describe("what a finished exam may claim about itself", () => {
  it("accepts what the exam screen actually sends", () => {
    assert.equal(accepts(payload()), true);
  });

  it("accepts a sitting abandoned during the monologue", () => {
    // One phase, no end stamp. The truth about it, and a shape the schema must
    // not mistake for a malformed request.
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "monologue", elapsedSeconds: 120, startedAt: 1_000_000, endedAt: null },
          ],
        }),
      ),
      true,
    );
  });

  it("accepts a monologue turn as long as a real one gets", () => {
    // The bound that would be easiest to set too tight. Fragments coalesce, so
    // the whole seven-minute exposé arrives as ONE entry — roughly nine thousand
    // characters of fast French.
    assert.equal(
      accepts(
        payload({
          transcript: [
            {
              phase: "monologue",
              speaker: "candidate",
              timestamp: 0,
              text: "a".repeat(9_000),
            },
          ],
        }),
      ),
      true,
    );
  });
});

describe("bounding what the server will buffer", () => {
  it("refuses a single turn longer than any speech", () => {
    assert.equal(
      accepts(
        payload({
          transcript: [
            {
              phase: "monologue",
              speaker: "candidate",
              timestamp: 0,
              text: "a".repeat(MAX_TURN_CHARS + 1),
            },
          ],
        }),
      ),
      false,
    );
  });

  it("refuses more turns than an épreuve has", () => {
    const turns = Array.from({ length: MAX_TURNS + 1 }, (_, i) => ({
      phase: "debate",
      speaker: "candidate",
      timestamp: i,
      text: "oui",
    }));
    assert.equal(accepts(payload({ transcript: turns })), false);
  });

  it("refuses a transcript that is legal turn by turn and absurd in total", () => {
    // The gap a per-field bound leaves open on its own: 500 turns of 20 000
    // characters each is 10 MB, every entry of it individually valid.
    const turns = Array.from({ length: MAX_TURNS }, (_, i) => ({
      phase: "debate",
      speaker: "candidate",
      timestamp: i,
      text: "a".repeat(MAX_TURN_CHARS),
    }));
    assert.ok(turns.length <= MAX_TURNS, "each field is within its own bound");
    assert.ok(
      turns.reduce((n, turn) => n + turn.text.length, 0) > MAX_TRANSCRIPT_CHARS,
      "and the total is not",
    );
    assert.equal(accepts(payload({ transcript: turns })), false);
  });

  it("refuses a topic slug longer than the column it is looked up against", () => {
    assert.equal(accepts(payload({ topicSlug: "x".repeat(129) })), false);
    assert.equal(accepts(payload({ topicSlug: "" })), false);
  });
});

describe("keeping the audit trail worth having", () => {
  it("refuses a phase that ended before it started", () => {
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "monologue", elapsedSeconds: 400, startedAt: 2_000_000, endedAt: 1_000_000 },
          ],
        }),
      ),
      false,
    );
  });

  it("refuses a phase that ended without ever starting", () => {
    // Unreachable from the exam screen — entering a phase is what stamps
    // `startedAt` — so a payload with this shape was hand-written, and writing
    // it into the audit columns would be recording a fiction.
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "monologue", elapsedSeconds: 400, startedAt: null, endedAt: 1_400_000 },
          ],
        }),
      ),
      false,
    );
  });

  it("refuses a clock no épreuve could have run for", () => {
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "debate", elapsedSeconds: 99_999_999, startedAt: 1_000, endedAt: 2_000 },
          ],
        }),
      ),
      false,
    );
  });

  it("refuses the same phase reported twice", () => {
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "debate", elapsedSeconds: 100, startedAt: 1_000, endedAt: 2_000 },
            { phase: "debate", elapsedSeconds: 200, startedAt: 3_000, endedAt: 4_000 },
          ],
        }),
      ),
      false,
    );
  });

  it("refuses a third phase, whatever it claims to be", () => {
    assert.equal(accepts(payload({ phases: [] })), true, "none is legal; an abandoned sitting");
    assert.equal(
      accepts(
        payload({
          phases: [
            { phase: "monologue", elapsedSeconds: 1, startedAt: 1, endedAt: 2 },
            { phase: "debate", elapsedSeconds: 1, startedAt: 3, endedAt: 4 },
            { phase: "monologue", elapsedSeconds: 1, startedAt: 5, endedAt: 6 },
          ],
        }),
      ),
      false,
    );
  });

  it("still rejects the NaN that used to reach the INSERT", () => {
    assert.equal(accepts(payload({ reconnectCount: Number.NaN })), false);
    assert.equal(accepts(payload({ reconnectCount: -1 })), false);
  });

  describe("the early-closing count (#92)", () => {
    // The one number in this payload that can RAISE a grade: positive, it
    // waives the débat's penalties. Bounded like `reconnectCount`, but with a
    // default where that field has none — see the schema for the deploy story.
    it("accepts what the controller counts", () => {
      assert.equal(accepts(payload({ earlyClosingCount: 0 })), true);
      assert.equal(accepts(payload({ earlyClosingCount: 3 })), true);
    });

    it("defaults an absent field to zero, for the sitting in flight across the deploy", () => {
      const parsed = finishPayloadSchema.safeParse(payload());
      assert.ok(parsed.success);
      assert.equal(parsed.data.earlyClosingCount, 0);
    });

    it("refuses the shapes that could not have been counted", () => {
      assert.equal(accepts(payload({ earlyClosingCount: -1 })), false);
      assert.equal(accepts(payload({ earlyClosingCount: 1.5 })), false);
      assert.equal(accepts(payload({ earlyClosingCount: Number.NaN })), false);
    });
  });

  describe("the development duration claim (#36)", () => {
    // The only field in this payload that can reach a mark. The schema is not
    // what stops it being abused — the route ignores it in production and lets
    // any real recording win — but it is what stops a hand-crafted one reaching
    // the arithmetic as NaN, as a negative, or as a four-figure hour count.
    it("is optional, and absent on every real sitting", () => {
      assert.equal(accepts(payload()), true);
      assert.equal(accepts(payload({ devSeconds: undefined })), true);
    });

    it("accepts a plausible pair", () => {
      assert.equal(accepts(payload({ devSeconds: { monologue: 330, debate: 320 } })), true);
      assert.equal(accepts(payload({ devSeconds: { monologue: 0, debate: 0 } })), true);
    });

    it("refuses a half-filled claim, so neither phase can default silently", () => {
      assert.equal(accepts(payload({ devSeconds: { monologue: 330 } })), false);
      assert.equal(accepts(payload({ devSeconds: {} })), false);
    });

    it("refuses the values that would poison the arithmetic", () => {
      assert.equal(accepts(payload({ devSeconds: { monologue: Number.NaN, debate: 0 } })), false);
      assert.equal(accepts(payload({ devSeconds: { monologue: -1, debate: 0 } })), false);
      assert.equal(
        accepts(payload({ devSeconds: { monologue: Number.POSITIVE_INFINITY, debate: 0 } })),
        false,
      );
    });

    it("is bounded by the same ceiling as the wall clock beside it", () => {
      assert.equal(
        accepts(payload({ devSeconds: { monologue: MAX_PHASE_SECONDS, debate: 0 } })),
        true,
      );
      assert.equal(
        accepts(payload({ devSeconds: { monologue: MAX_PHASE_SECONDS + 1, debate: 0 } })),
        false,
      );
    });
  });
});
