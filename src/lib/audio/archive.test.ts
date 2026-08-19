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

  it("reports zero for a phase that captured nothing", async () => {
    // Not null, not the phase clock. A candidate whose microphone was refused
    // produced no audio, and the penalty rules are entitled to hear that.
    const archive = new PhaseArchive();
    assert.equal(archive.measuredSeconds("monologue"), 0);
    assert.equal(await archive.recordingFor("monologue"), null, "and there is no artefact to play");
  });

  it("keeps the two phases apart and in order", async () => {
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
      (await archive.all()).map((recording) => recording.phase),
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
  it("is discarded, and counted rather than swallowed", async () => {
    // The room tone between the permission prompt and the exposé, and the
    // examiner's closing sentence after the clock runs out. Neither is part of a
    // task; both would otherwise land in whichever artefact happened to be open.
    const archive = new PhaseArchive();
    fill(archive, 3);

    assert.equal(archive.totalSeconds, 0);
    assert.equal(archive.discarded, 3 * INPUT_SAMPLE_RATE);
    assert.deepEqual(await archive.all(), []);
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

    const recording = await archive.recordingFor("monologue");
    assert.ok(recording);
    assert.equal(recording.durationSeconds, 7);
    assert.equal(recording.sampleCount, 7 * INPUT_SAMPLE_RATE);
    assert.equal(recording.byteSize, 44 + 7 * INPUT_SAMPLE_RATE * 2);
    assert.equal(await wavDurationSeconds(await recording.blob.arrayBuffer()), 7);
  });

  it("stitches the frames back together in the order they arrived", async () => {
    const archive = new PhaseArchive();
    archive.begin("debate");
    archive.append(Int16Array.from([1, 2]));
    archive.append(Int16Array.from([3, 4, 5]));

    const recording = await archive.recordingFor("debate");
    assert.ok(recording);
    assert.equal(recording.sampleCount, 5);
  });

  it("hands the samples to the encoder it was built with, and reports what came back", async () => {
    // The archive owns the duration; the transport owns the format. A sitting
    // leaves the tab as Opus (#24) and no test in this file needs a codec to
    // prove the arithmetic, which is exactly why the encoder is injected.
    const seen: Array<{ samples: number; rate: number }> = [];
    const archive = new PhaseArchive(INPUT_SAMPLE_RATE, async (pcm, sampleRate) => {
      seen.push({ samples: pcm.length, rate: sampleRate });
      return { blob: new Blob([new Uint8Array(120)]), mimeType: "audio/ogg" };
    });

    archive.begin("monologue");
    fill(archive, 5);
    const recording = await archive.recordingFor("monologue");

    assert.ok(recording);
    assert.equal(recording.mimeType, "audio/ogg");
    assert.equal(recording.byteSize, 120, "the size of the artefact, not of the PCM");
    assert.deepEqual(seen, [{ samples: 5 * INPUT_SAMPLE_RATE, rate: INPUT_SAMPLE_RATE }]);
    // The number the duration penalty rests on is the archive's own count, so
    // it does not move when the artefact is compressed to a hundredth its size.
    assert.equal(recording.durationSeconds, 5);
    assert.equal(recording.sampleCount, 5 * INPUT_SAMPLE_RATE);
  });

  it("encodes each phase on its own, so one can fall back without the other", async () => {
    // Reachable, and worth pinning: the encoder is asked once per phase, so a
    // transient WebCodecs failure during the débat leaves a WAV beside a
    // perfectly good Opus monologue. The client has to weigh the two artefacts
    // separately because of this — see `selectDeliverable` — and it can only do
    // that if they are allowed to differ here.
    const archive = new PhaseArchive(INPUT_SAMPLE_RATE, async (pcm, sampleRate) => {
      if (pcm.length > 3 * sampleRate) throw new Error("the encoder gave up");
      return { blob: new Blob([new Uint8Array(64)]), mimeType: "audio/ogg" };
    });

    archive.begin("monologue");
    fill(archive, 2);
    archive.end();
    archive.begin("debate");
    fill(archive, 9);
    archive.end();

    // The failure is the encoder's to report and the caller's to handle; the
    // archive does not swallow it into a silent zero-length artefact.
    await assert.rejects(() => archive.all(), /the encoder gave up/);
    assert.equal((await archive.recordingFor("monologue"))?.mimeType, "audio/ogg");
    // And the measurement is untouched by any of it.
    assert.equal(archive.measuredSeconds("debate"), 9);
  });

  it("releases its memory when told to, and not before", async () => {
    // A sitting is roughly 38 MB of PCM. Cutting the blobs does not free it —
    // the blobs own their own bytes — so something has to, once the tab no
    // longer needs the second copy.
    const archive = new PhaseArchive();
    archive.begin("monologue");
    fill(archive, 4);

    assert.equal(archive.totalSeconds, 4, "still held while the blobs are being cut");
    archive.clear();
    assert.equal(archive.totalSeconds, 0);
    assert.deepEqual(await archive.all(), []);
    assert.equal(archive.openPhase, null);
  });
});
