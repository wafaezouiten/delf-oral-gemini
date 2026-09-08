import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decidePlayback,
  parseRecordedPhase,
  type RecordingRowForPlayback,
} from "./recording-playback";

/**
 * The playback route's whole decision table, proven off the route (#98) — the
 * route itself imports `server-only` and cannot be loaded here, which is the
 * same bargain every route in this project makes: the branching lives in a
 * module `node --test` can reach, and the route maps outcomes to statuses.
 */

const KEPT: RecordingRowForPlayback = {
  uri: "https://store.example/recordings/41/monologue.ogg",
  mimeType: "audio/ogg",
  byteSize: 210_000,
  deletedAt: null,
};

describe("parsing the phase segment", () => {
  it("admits exactly the two speaking phases", () => {
    assert.equal(parseRecordedPhase("monologue"), "monologue");
    assert.equal(parseRecordedPhase("debate"), "debate");
  });

  it("refuses everything else in the url", () => {
    // `preparation` and `finished` are real phases that can never own audio,
    // and the rest is arbitrary visitor input on a public segment.
    for (const segment of ["preparation", "finished", "", "MONOLOGUE", "débat", "../../etc"]) {
      assert.equal(parseRecordedPhase(segment), null, segment);
    }
  });
});

describe("deciding what an owned row can play", () => {
  it("plays a kept recording through a configured vault", () => {
    assert.deepEqual(decidePlayback(KEPT, true), {
      status: "playable",
      uri: KEPT.uri,
      mimeType: "audio/ogg",
    });
  });

  it("has nothing to play where no row exists", () => {
    // A phase whose microphone never worked, a text-mode sitting, a sitting
    // that never got this far — states the product already reports elsewhere.
    assert.deepEqual(decidePlayback(null, true), { status: "no-recording" });
  });

  it("reports a pre-#98 row — no uri, stamped disposed — as disposed, not broken", () => {
    // Every sitting from before the vault existed looks exactly like this, and
    // it must render as the honest sentence rather than a dead player.
    const legacy: RecordingRowForPlayback = {
      uri: null,
      mimeType: "audio/ogg",
      byteSize: 210_000,
      deletedAt: new Date("2026-06-01T10:00:00Z"),
    };
    assert.deepEqual(decidePlayback(legacy, true), { status: "disposed" });
  });

  it("lets deleted_at outrank a uri that was never cleared", () => {
    // A purge stamps the row first and clears the store second; between the
    // two, the row already speaks for the intent.
    const purged: RecordingRowForPlayback = {
      ...KEPT,
      deletedAt: new Date("2026-08-01T10:00:00Z"),
    };
    assert.deepEqual(decidePlayback(purged, true), { status: "disposed" });
  });

  it("calls a kept recording unreachable when this deployment has no vault", () => {
    // The one state that is our fault rather than a fact about the recording:
    // the bytes exist, the row promises them, and credentials are missing.
    assert.deepEqual(decidePlayback(KEPT, false), { status: "vault-unreachable" });
  });

  it("does not ask for a vault it will not use", () => {
    // A vaultless deployment showing pre-#98 sittings is the common case, and
    // those must read as disposed — never as a config error.
    const legacy: RecordingRowForPlayback = { ...KEPT, uri: null, deletedAt: new Date() };
    assert.deepEqual(decidePlayback(legacy, false), { status: "disposed" });
  });
});
