import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { controlsView, type ControlsInput } from "./conversation-controls";

/** Mid-débat, recording, connected: the stop button. */
const live: ControlsInput = {
  phase: "debate",
  canAdvance: true,
  connecting: false,
  recording: true,
  awaitingStart: false,
  startDisabled: false,
  closing: false,
  emptyTranscript: false,
  hasDevPanel: false,
};

describe("the control bar's view", () => {
  it("is the armed « Enregistrer » before the part starts, held while the consigne plays", () => {
    const { mic } = controlsView({ ...live, awaitingStart: true, recording: false });
    assert.equal(mic.look, "armed");
    assert.equal(mic.action, "start");
    assert.equal(mic.icon, "mic");
    assert.equal(mic.text, "Enregistrer");
    assert.equal(mic.disabled, false);
    assert.equal(mic.pulsing, false, "nothing is being captured yet");

    const held = controlsView({ ...live, awaitingStart: true, startDisabled: true }).mic;
    assert.equal(held.disabled, true);
  });

  it("is the red stop while recording, pulsing, and ends the part", () => {
    const { mic } = controlsView(live);
    assert.equal(mic.look, "recording");
    assert.equal(mic.action, "advance");
    assert.equal(mic.icon, "stop");
    assert.equal(mic.pulsing, true);
    assert.equal(mic.disabled, false);
    assert.equal(mic.text, "Terminer");
  });

  it("spins and refuses presses while connecting, but keeps pulsing if the microphone is live", () => {
    const { mic } = controlsView({ ...live, connecting: true });
    assert.equal(mic.icon, "loading");
    assert.equal(mic.disabled, true);
    assert.equal(mic.look, "recording");
    assert.equal(mic.pulsing, true);
  });

  it("goes inert through the closing handshake, still pulsing while the candidate is recorded", () => {
    const { mic } = controlsView({ ...live, closing: true });
    assert.equal(mic.look, "inert");
    assert.equal(mic.icon, "loading");
    assert.equal(mic.disabled, true);
    assert.equal(mic.pulsing, true);
    assert.equal(mic.text, "Terminé");
  });

  it("is the plain primary stop when the microphone is not capturing", () => {
    const { mic } = controlsView({ ...live, recording: false });
    assert.equal(mic.look, "primary");
    assert.equal(mic.pulsing, false);
  });

  it("lets the épreuve be ended from the débat only, and says why otherwise", () => {
    assert.deepEqual(controlsView(live).finish, { disabled: false, title: undefined });
    assert.equal(controlsView({ ...live, canAdvance: false }).finish.disabled, true);
    const monologue = controlsView({ ...live, phase: "monologue" }).finish;
    assert.equal(monologue.disabled, true);
    assert.match(monologue.title ?? "", /débat doit avoir lieu/);
  });

  it("opens the corner for the empty-transcript alert or the dev panel, and not otherwise", () => {
    assert.equal(controlsView(live).corner, false);
    assert.equal(controlsView({ ...live, emptyTranscript: true }).corner, true);
    assert.equal(controlsView({ ...live, hasDevPanel: true }).corner, true);
  });
});
