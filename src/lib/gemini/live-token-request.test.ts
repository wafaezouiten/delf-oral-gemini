import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExamAccess } from "@/lib/auth/exam-access";
import { ORAL_TOPICS } from "@/lib/delf/topics";
import { LIVE_MODEL, LIVE_MODEL_OPTIONS } from "@/lib/gemini/constants";
import {
  MAX_RESUMPTION_HANDLE_LENGTH,
  gateLiveToken,
  parseLiveTokenRequest,
} from "./live-token-request";

/**
 * The token route's two jobs, tested where they can be: what it accepts, and
 * what it is willing to mint.
 *
 * Both matter more than they look. A token carries the examiner's whole session
 * config, pinned server-side — so whatever these functions wave through decides
 * which exam a credential can open and which subject the examiner will believe
 * the candidate prepared.
 */

const SLUG = ORAL_TOPICS[0].slug;
const OTHER_SLUG = ORAL_TOPICS[1].slug;

/** An allow-listed examiner that is not the default, so a test can tell "the
 *  choice won" apart from "the default won". */
const OTHER_MODEL = LIVE_MODEL_OPTIONS.map((option) => option.id).find(
  (id) => id !== LIVE_MODEL,
)!;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { phase: "debate", examId: "42", topicSlug: SLUG, ...overrides };
}

describe("live token request validation", () => {
  it("accepts a well-formed request", () => {
    const parsed = parseLiveTokenRequest(body({ resumptionHandle: "handle-one" }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.request, {
      phase: "debate",
      examId: "42",
      requestedTopicSlug: SLUG,
      requestedModel: undefined,
      resumptionHandle: "handle-one",
    });
  });

  it("refuses a phase that is not one of the two speaking phases", () => {
    // `preparation` is silent by design: a token for it would be a session
    // nobody should be able to open.
    for (const phase of ["preparation", "finished", "", 2, null, undefined]) {
      const parsed = parseLiveTokenRequest(body({ phase }));
      assert.equal(parsed.ok, false, String(phase));
      assert.equal(!parsed.ok && parsed.status, 400);
    }
  });

  it("refuses a request that names no sitting", () => {
    // Without this the route cannot ask who owns anything, which is how the
    // endpoint went unscoped until Phase 4.
    for (const examId of [undefined, "", 42, "x".repeat(129)]) {
      assert.equal(parseLiveTokenRequest(body({ examId })).ok, false, String(examId));
    }
  });

  it("refuses a subject outside the catalogue", () => {
    // The slug reaches the prompt builder, so it is checked against the
    // catalogue rather than merely type-checked.
    for (const topicSlug of ["../../etc", "inconnu", "", undefined, 7]) {
      assert.equal(parseLiveTokenRequest(body({ topicSlug })).ok, false, String(topicSlug));
    }
    assert.equal(parseLiveTokenRequest(body({ topicSlug: OTHER_SLUG })).ok, true);
  });

  it("treats a missing or oversized resumption handle as no handle at all", () => {
    // The handle is opaque to us and comes from the browser, so it is bounded
    // rather than forwarded to Google at whatever length it arrives.
    const long = "x".repeat(MAX_RESUMPTION_HANDLE_LENGTH + 1);
    for (const resumptionHandle of [undefined, "", long, 12, {}]) {
      const parsed = parseLiveTokenRequest(body({ resumptionHandle }));
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ok && parsed.request.resumptionHandle, undefined);
    }

    const atLimit = "x".repeat(MAX_RESUMPTION_HANDLE_LENGTH);
    const parsed = parseLiveTokenRequest(body({ resumptionHandle: atLimit }));
    assert.equal(parsed.ok && parsed.request.resumptionHandle, atLimit);
  });

  it("survives a body that is not an object at all", () => {
    for (const raw of [null, undefined, "", 0]) {
      assert.equal(parseLiveTokenRequest(raw).ok, false);
    }
  });

  it("refuses a model outside the allow-list, and loudly", () => {
    // The one part of the pinned config the client now has an opinion on
    // (#99). An unknown id must die HERE with a 400: passed through, it opens
    // a socket that is killed with 1011 and no diagnostic, mid-épreuve.
    for (const model of ["gemini-9-imaginary", "", 7, {}]) {
      const parsed = parseLiveTokenRequest(body({ model }));
      assert.equal(parsed.ok, false, String(model));
      assert.equal(!parsed.ok && parsed.status, 400);
    }
  });

  it("accepts every allow-listed model, and treats absence as no request", () => {
    for (const { id } of LIVE_MODEL_OPTIONS) {
      const parsed = parseLiveTokenRequest(body({ model: id }));
      assert.equal(parsed.ok && parsed.request.requestedModel, id);
    }
    const absent = parseLiveTokenRequest(body());
    assert.equal(absent.ok && absent.request.requestedModel, undefined);
  });
});

describe("who may be minted a live token", () => {
  /** The sitting says SLUG. Since #22 the subject arrives on the access
   *  itself; since #99 the examiner does too, and this row predates a choice. */
  const owned: ExamAccess = {
    status: "owned",
    userId: "user_1",
    examId: 42,
    topicSlug: SLUG,
    examinerModel: null,
  };

  it("mints for the subject recorded on the sitting, not the one asked for", () => {
    // The integrity bug this closes: a candidate could sit subject A on a row
    // that says subject B, and the grade would be filed against B.
    const gate = gateLiveToken({ access: owned, requestedTopicSlug: OTHER_SLUG });
    assert.deepEqual(gate, {
      decision: "mint",
      topicSlug: SLUG,
      source: "sitting",
      model: LIVE_MODEL,
      modelSource: "default",
    });
  });

  it("refuses a signed-out caller", () => {
    const gate = gateLiveToken({
      access: { status: "denied", reason: "unauthenticated" },
      requestedTopicSlug: SLUG,
    });
    assert.deepEqual(gate, { decision: "deny", status: 401, error: "Non authentifié" });
  });

  it("refuses someone else's sitting with a 404, never a 403", () => {
    // A 403 would confirm the sitting exists, which is exactly the fact a caller
    // who does not own it has no business learning.
    const gate = gateLiveToken({
      access: { status: "denied", reason: "not-found" },
      requestedTopicSlug: SLUG,
    });
    assert.equal(gate.decision, "deny");
    assert.equal(gate.decision === "deny" && gate.status, 404);
  });

  it("still mints when there is no sitting to read", () => {
    // The exam loop is meant to run without a database, and a reconnect happens
    // every ten minutes: refusing here would end an épreuve over a missing
    // `DATABASE_URL`. Neither degraded path can reach another candidate's
    // sitting — that is decided by `access`, not by this fallback.
    for (const reason of ["no-database", "unpersisted-id", "lookup-failed"] as const) {
      const gate = gateLiveToken({
        access: { status: "no-sitting", userId: "user_1", reason },
        requestedTopicSlug: SLUG,
      });
      assert.deepEqual(
        gate,
        {
          decision: "mint",
          topicSlug: SLUG,
          source: "request",
          model: LIVE_MODEL,
          modelSource: "default",
        },
        reason,
      );
    }
  });

  it("falls back to the requested subject when an owned sitting has none readable", () => {
    // Should not happen — `topic_id` is NOT NULL — but a join that came back
    // empty is a server fault, and ending a live débat over one is worse than
    // continuing with the subject the candidate is visibly looking at.
    const gate = gateLiveToken({
      access: { ...owned, topicSlug: null },
      requestedTopicSlug: OTHER_SLUG,
    });
    assert.deepEqual(gate, {
      decision: "mint",
      topicSlug: OTHER_SLUG,
      source: "request",
      model: LIVE_MODEL,
      modelSource: "default",
    });
  });
});

describe("which examiner a token is minted for", () => {
  const owned: ExamAccess = {
    status: "owned",
    userId: "user_1",
    examId: 42,
    topicSlug: SLUG,
    examinerModel: OTHER_MODEL,
  };

  it("mints for the examiner recorded on the sitting, not the one asked for", () => {
    // The same rule as the subject, for the same reason: the row is the record
    // of what the candidate heard, and the request loses whenever a row
    // answers. This is also what keeps a reload honest — the picker rerenders
    // from the row, and the token route mints from the same place.
    const gate = gateLiveToken({
      access: owned,
      requestedTopicSlug: SLUG,
      requestedModel: LIVE_MODEL,
    });
    assert.equal(gate.decision === "mint" && gate.model, OTHER_MODEL);
    assert.equal(gate.decision === "mint" && gate.modelSource, "sitting");
  });

  it("runs the default on an owned row that never chose, whatever was asked", () => {
    // Null means "nothing was ever chosen", and the row wins even then:
    // honouring a request the row does not carry would make the stored record
    // a lie about which voice spoke. The picker's write goes to the row first,
    // so a request the row disagrees with is a write that failed.
    const gate = gateLiveToken({
      access: { ...owned, examinerModel: null },
      requestedTopicSlug: SLUG,
      requestedModel: OTHER_MODEL,
    });
    assert.equal(gate.decision === "mint" && gate.model, LIVE_MODEL);
    assert.equal(gate.decision === "mint" && gate.modelSource, "default");
  });

  it("keeps a reconnect on the requested examiner when no row can be read", () => {
    // Trap 3 of #99: a token is minted on every reconnect. The client re-sends
    // its choice each time, so a database blip mid-débat keeps the same voice
    // instead of silently switching examiners.
    for (const reason of ["no-database", "unpersisted-id", "lookup-failed"] as const) {
      const gate = gateLiveToken({
        access: { status: "no-sitting", userId: "user_1", reason },
        requestedTopicSlug: SLUG,
        requestedModel: OTHER_MODEL,
      });
      assert.equal(gate.decision === "mint" && gate.model, OTHER_MODEL, reason);
      assert.equal(gate.decision === "mint" && gate.modelSource, "request", reason);
    }
  });

  it("falls back to the default when the stored examiner has left the allow-list", () => {
    // Trap 4 of #99: an id can exist, be stored, and still be unrunnable — a
    // retired preview dies at the handshake with 1011 and no diagnostic. An
    // épreuve on the wrong examiner beats one that cannot start; the route
    // logs the substitution off `modelSource`.
    const gate = gateLiveToken({
      access: { ...owned, examinerModel: "gemini-3-pro-preview" },
      requestedTopicSlug: SLUG,
    });
    assert.equal(gate.decision === "mint" && gate.model, LIVE_MODEL);
    assert.equal(gate.decision === "mint" && gate.modelSource, "default");
  });

  it("still names the sitting's examiner when its subject could not be joined", () => {
    // The two columns are decided independently: a broken topic join degrades
    // the SUBJECT to the request, and says nothing about which examiner the
    // row recorded.
    const gate = gateLiveToken({
      access: { ...owned, topicSlug: null },
      requestedTopicSlug: SLUG,
    });
    assert.equal(gate.decision === "mint" && gate.source, "request");
    assert.equal(gate.decision === "mint" && gate.model, OTHER_MODEL);
    assert.equal(gate.decision === "mint" && gate.modelSource, "sitting");
  });
});
