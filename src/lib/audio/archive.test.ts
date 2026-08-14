import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import { PhaseArchive } from "./archive";
import { wavDurationSeconds } from "./pcm";

/**
 * The recording's arithmetic, away from the microphone.
 *
 * Everything here is about one number: the duration the DELF duration penalty is
 * computed from. It has to come from the samples, it has to survive a phase
 * boundary, and it has to be zero — not absent, not the phase clock — when a
 * phase captured nothing.
 */

/** `seconds` of audio, as the framer would deliver it: 40 ms frames. */
function frames(seconds: number): Int16Array[] {
  const perFrame = INPUT_SAMPLE_RATE / 25;
  return Array.from({ length: Math.round(seconds * 25) }, () => new Int16Array(perFrame).fill(1000));
}

function fill(archive: PhaseArchive, seconds: number): void {
  for (const frame of frames(seconds)) archive.append(frame);
}

describe("measuring a phase", () => {
  it("takes the duration from the samples", () => {
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 6);

    assert.equal(archive.measuredSeconds("monologue"), 6);
    assert.equal(archive.samplesIn("monologue"), 6 * INPUT_SAMPLE_RATE);
  });

  it("measures a partial frame as the fraction of a second it is", () => {
    // The last frame of a phase is short by design — it is what the candidate
    // said before the clock ran out, not a padded one. Rounding it up to a whole
    // frame would add manufactured silence to a recording used to judge fluency.
    const archive = new PhaseArchive();
    archive.begin("debate");
    archive.append(new Int16Array(400));

    assert.equal(archive.measuredSeconds("debate"), 400 / INPUT_SAMPLE_RATE);
  });

  it("reports zero for a phase that captured nothing", () => {
    // Not null, not the phase clock. A candidate whose microphone was refused
    // produced no audio, and the penalty rules are entitled to hear that.
    const archive = new PhaseArchive();
    assert.equal(archive.measuredSeconds("monologue"), 0);
    assert.equal(archive.recordingFor("monologue"), null, "and there is no artefact to play");
  });

  it("keeps the two phases apart and in order", () => {
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 6);
    archive.end();
    archive.begin("debate");
    fill(archive, 13);
    archive.end();

    assert.equal(archive.measuredSeconds("monologue"), 6);
    assert.equal(archive.measuredSeconds("debate"), 13);
    assert.equal(archive.totalSeconds, 19);
    assert.deepEqual(
      archive.all().map((recording) => recording.phase),
      ["monologue", "debate"],
    );
  });

  it("continues a phase that is re-opened rather than restarting it", () => {
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 2);
    archive.begin("monologue");
    fill(archive, 2);

    assert.equal(archive.measuredSeconds("monologue"), 4);
  });

  it("measures at the rate it was built with, not at 16 kHz by assumption", () => {
    const archive = new PhaseArchive(8000);
    archive.begin("debate");
    archive.append(new Int16Array(8000));

    assert.equal(archive.measuredSeconds("debate"), 1);
  });

  it("refuses a rate that cannot measure anything", () => {
    assert.throws(() => new PhaseArchive(0), RangeError);
  });
});

describe("audio that belongs to no phase", () => {
  it("is discarded, and counted rather than swallowed", () => {
    // The room tone between the permission prompt and the exposé, and the
    // examiner's closing sentence after the clock runs out. Neither is part of a
    // task; both would otherwise land in whichever artefact happened to be open.
    const archive = new PhaseArchive();
    fill(archive, 3);

    assert.equal(archive.totalSeconds, 0);
    assert.equal(archive.discarded, 3 * INPUT_SAMPLE_RATE);
    assert.deepEqual(archive.all(), []);
  });

  it("stops being recorded the moment the phase ends", () => {
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 1);
    archive.end();
    fill(archive, 5);

    assert.equal(archive.measuredSeconds("monologue"), 1);
    assert.equal(archive.openPhase, null);
    assert.equal(archive.discarded, 5 * INPUT_SAMPLE_RATE);
  });
});

describe("the artefact itself", () => {
  it("is a WAV whose own header agrees with the measurement", async () => {
    // Two readers of the same fact: the number that reaches the database, and
    // the file a player (or the evaluator) opens. A disagreement between them is
    // a grade computed against a length nobody can hear.
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 7);

    const recording = archive.recordingFor("monologue");
    assert.ok(recording);
    assert.equal(recording.durationSeconds, 7);
    assert.equal(recording.sampleCount, 7 * INPUT_SAMPLE_RATE);
    assert.equal(recording.byteSize, 44 + 7 * INPUT_SAMPLE_RATE * 2);
    assert.equal(await wavDurationSeconds(await recording.blob.arrayBuffer()), 7);
  });

  it("stitches the frames back together in the order they arrived", () => {
    const archive = new PhaseArchive();
    archive.begin("debate");
    archive.append(Int16Array.from([1, 2]));
    archive.append(Int16Array.from([3, 4, 5]));

    const recording = archive.recordingFor("debate");
    assert.ok(recording);
    assert.equal(recording.sampleCount, 5);
  });

  it("releases its memory when told to, and not before", () => {
    // A sitting is roughly 38 MB of PCM. Cutting the blobs does not free it —
    // the blobs own their own bytes — so something has to, once the tab no
    // longer needs the second copy.
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 4);

    assert.equal(archive.totalSeconds, 4, "still held while the blobs are being cut");
    archive.clear();
    assert.equal(archive.totalSeconds, 0);
    assert.deepEqual(archive.all(), []);
    assert.equal(archive.openPhase, null);
  });
});
