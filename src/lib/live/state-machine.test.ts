import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORAL_PHASES } from "@/lib/delf/phases";
import {
  EXAM_STATUSES,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  canTransition,
  examStatus,
  isLive,
  isRecovering,
  type SessionState,
} from "./state-machine";

/**
 * The transition table is the file's whole point, so these tests are about the
 * SHAPE of the machine rather than any one journey through it: which states can
 * be reached from where, and which combinations of phase and connection the
 * candidate is shown.
 */

describe("session state machine", () => {
  it("declares a transition list for every state, and only of real states", () => {
    assert.deepEqual(Object.keys(SESSION_TRANSITIONS).sort(), [...SESSION_STATES].sort());
    for (const [from, targets] of Object.entries(SESSION_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(SESSION_STATES.includes(to), `${from} -> ${to} names a state that exists`);
        assert.notEqual(to, from, `${from} does not list itself; self-transitions are no-ops`);
      }
    }
  });

  it("only reaches `connected` from a state that was opening a socket", () => {
    // Otherwise the exam could claim to be live without a socket having just
    // been opened — which is how a dead session goes unnoticed.
    const openers = SESSION_STATES.filter((state) => canTransition(state, "connected"));
    assert.deepEqual(openers.sort(), ["connected", "connecting", "resuming"]);
  });

  it("treats `closed` as terminal, so a torn-down phase cannot revive", () => {
    // A monologue session that could come back would talk over the débat.
    assert.deepEqual(SESSION_TRANSITIONS.closed, []);
    for (const state of SESSION_STATES) {
      if (state === "closed") continue;
      assert.equal(canTransition("closed", state), false, `closed -/-> ${state}`);
    }
  });

  it("lets a failed session be retried, because the candidate can ask", () => {
    // `failed` means backoff was exhausted, not that the exam is unrecoverable:
    // the forced-reconnect control still works, and an exam that cannot be
    // retried is worse than one that can.
    assert.equal(canTransition("failed", "reconnecting"), true);
    assert.equal(canTransition("failed", "connected"), false, "but not without reconnecting first");
  });

  it("allows the goAway path end to end: connected, reconnecting, resuming, connected", () => {
    const path: SessionState[] = ["connected", "reconnecting", "resuming", "connected"];
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
    }
  });

  it("allows a first connect and refuses a first resume-to-live shortcut", () => {
    assert.equal(canTransition("idle", "connecting"), true);
    assert.equal(canTransition("idle", "connected"), false);
  });

  it("treats self-transitions as legal no-ops", () => {
    for (const state of SESSION_STATES) {
      assert.equal(canTransition(state, state), true);
    }
  });

  it("says which states are live and which are merely recovering", () => {
    // The UI colour depends on this: recovering is amber and reassuring,
    // failed is red. Getting it wrong makes candidates abandon a healthy exam.
    assert.equal(isLive("connected"), true);
    assert.equal(isLive("resuming"), false);
    assert.deepEqual(SESSION_STATES.filter(isRecovering), ["resuming", "reconnecting"]);
    assert.equal(isRecovering("failed"), false);
  });
});

describe("the flattened exam status", () => {
  it("covers every (phase, session) pair with a declared status", () => {
    for (const phase of ORAL_PHASES) {
      for (const session of SESSION_STATES) {
        const status = examStatus(phase, session);
        assert.ok(EXAM_STATUSES.includes(status), `${phase} + ${session} => ${status}`);
      }
    }
  });

  it("reports the speaking phase while the session is healthy", () => {
    assert.equal(examStatus("monologue", "connected"), "monologue");
    assert.equal(examStatus("debate", "connected"), "debate");
  });

  it("reports recovery over the phase, because that is what the candidate needs told", () => {
    assert.equal(examStatus("debate", "reconnecting"), "reconnecting");
    assert.equal(examStatus("debate", "resuming"), "resuming");
  });

  it("ignores the connection entirely during preparation", () => {
    // No socket is open during preparation by design, so `idle` there is
    // correct rather than a fault to surface.
    for (const session of SESSION_STATES) {
      assert.equal(examStatus("preparation", session), "preparation");
    }
  });

  it("reports `error` only for a session that gave up", () => {
    assert.equal(examStatus("debate", "failed"), "error");
    assert.equal(examStatus("monologue", "failed"), "error");
    assert.equal(examStatus("debate", "closed"), "debate", "a closed socket alone is not an error");
  });

  it("lets `finished` win over everything, including a dying socket", () => {
    // The exam is over; whatever the connection does on its way down is not a
    // state worth showing, and certainly not an error.
    for (const session of SESSION_STATES) {
      assert.equal(examStatus("finished", session), "finished");
    }
  });
});
