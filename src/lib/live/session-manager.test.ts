import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDurationMs } from "./session-manager";

/**
 * `goAway.timeLeft` is the trigger for a graceful reconnect, and it arrives in
 * more than one shape. Misreading it means either reconnecting instantly (losing
 * audio we did not have to lose) or too late (being cut off mid-sentence), so
 * the parser is worth pinning down.
 */
describe("goAway timeLeft parsing", () => {
  it("reads the protobuf duration string", () => {
    assert.equal(parseDurationMs("9.5s"), 9500);
    assert.equal(parseDurationMs("30s"), 30000);
  });

  it("reads a plain number as seconds", () => {
    assert.equal(parseDurationMs(4), 4000);
  });

  it("reads the structured {seconds, nanos} form", () => {
    assert.equal(parseDurationMs({ seconds: 2, nanos: 500_000_000 }), 2500);
    assert.equal(parseDurationMs({ seconds: "7" }), 7000);
  });

  it("returns null for anything unrecognised, so the caller reconnects at once", () => {
    assert.equal(parseDurationMs(undefined), null);
    assert.equal(parseDurationMs(null), null);
    assert.equal(parseDurationMs("bientôt"), null);
  });
});
