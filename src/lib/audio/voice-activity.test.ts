import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { frameRms, isVoiced, VOICE_RMS_THRESHOLD } from "./voice-activity";

/** A sine at a given amplitude (0..1 of full scale) — a stand-in for a voice. */
function tone(amplitude: number, samples = 640): Int16Array {
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    frame[i] = Math.round(Math.sin((i / samples) * Math.PI * 2 * 8) * amplitude * 32_767);
  }
  return frame;
}

describe("frame RMS", () => {
  it("is zero for digital silence", () => {
    assert.equal(frameRms(new Int16Array(640)), 0);
  });

  it("is zero for an empty frame rather than NaN", () => {
    // It feeds a comparison, and a NaN there answers "not voiced" for a reason
    // nobody could see.
    assert.equal(frameRms(new Int16Array(0)), 0);
  });

  it("is about 0.7 of the amplitude of a sine, as RMS is", () => {
    const rms = frameRms(tone(1));
    assert.ok(Math.abs(rms - Math.SQRT1_2) < 0.02, `got ${rms}`);
  });

  it("rises with amplitude", () => {
    assert.ok(frameRms(tone(0.5)) > frameRms(tone(0.1)));
  });

  it("is NOT immune to a single click, which is why the seconds threshold exists", () => {
    // Worth pinning, because it is the tempting thing to assume. One full-scale
    // sample in a 640-sample frame is √(1/640) ≈ 0.0395 — over the threshold.
    // Per-frame, a click and a soft voice are not separable: a 0.05 amplitude
    // sine measures 0.035, *below* the click. Raising the threshold to reject
    // clicks would reject quiet speakers.
    //
    // The protection is downstream: a frame is 40 ms, so one click buys 0.04
    // voiced seconds against a floor measured in whole seconds.
    const click = new Int16Array(640);
    click[100] = 32_767;
    assert.ok(frameRms(click) > VOICE_RMS_THRESHOLD, `rms was ${frameRms(click)}`);
    assert.ok(frameRms(click) > frameRms(tone(0.05)), "and a click outweighs a soft voice");
  });
});

describe("deciding a frame is voiced", () => {
  it("rejects digital silence", () => {
    assert.equal(isVoiced(new Int16Array(640)), false);
  });

  it("rejects room tone", () => {
    // A quiet room through a laptop microphone sits well under the threshold.
    assert.equal(isVoiced(tone(0.005)), false);
  });

  it("accepts conversational speech", () => {
    // An order of magnitude above room tone. The gap between the two is the
    // only reason one fixed number is defensible.
    assert.equal(isVoiced(tone(0.2)), true);
    assert.equal(isVoiced(tone(0.05)), true);
  });

  it("takes the threshold as a parameter, so it can be tuned or tested", () => {
    const quiet = tone(0.01);
    assert.equal(isVoiced(quiet, VOICE_RMS_THRESHOLD), false);
    assert.equal(isVoiced(quiet, 0.001), true);
  });
});
