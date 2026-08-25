import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OralTopic } from "@/lib/delf/topics";
import { debateConfig, liveConfigForPhase, monologueConfig } from "./live-config";

/**
 * These assertions guard the two claims the whole design rests on. Both are
 * invisible at runtime until they break, and both break silently:
 *
 *  - if automatic VAD is ever re-enabled for the monologue, the examiner starts
 *    interrupting and the monologue suivi stops being one;
 *  - if `sessionResumption` is ever dropped, the server stops issuing handles,
 *    every reconnect restarts the exam, and nothing throws to say so.
 */

const TOPIC: OralTopic = {
  slug: "teletravail",
  title: "Le télétravail a-t-il vraiment amélioré nos vies ?",
  document: "Un document déclencheur de test.",
  consigne: "Une consigne de test.",
};

describe("monologue Live configuration", () => {
  it("disables automatic voice-activity detection", () => {
    // THE mechanism: with automatic VAD off and no activityEnd sent, the model
    // has no turn boundary and is structurally unable to interrupt. Re-enabling
    // this silently turns the monologue back into a chat.
    const config = monologueConfig({ topic: TOPIC });
    assert.equal(config.realtimeInputConfig?.automaticActivityDetection?.disabled, true);
  });

  it("still transcribes the candidate while the examiner stays silent", () => {
    // Silence must not cost us the transcript: the monologue is half the grade.
    const config = monologueConfig({ topic: TOPIC });
    assert.ok(config.inputAudioTranscription, "candidate speech is transcribed");
    assert.ok(config.outputAudioTranscription, "the examiner's two lines are transcribed");
  });

  it("carries the monologue instruction, not the debate one", () => {
    const config = monologueConfig({ topic: TOPIC });
    const instruction = String(config.systemInstruction);
    assert.ok(instruction.includes("MONOLOGUE SUIVI"));
    assert.ok(instruction.includes(TOPIC.title), "the subject reaches the examiner");
    assert.ok(!instruction.includes("avocat du diable"), "not yet adversarial");
  });
});

describe("debate Live configuration", () => {
  it("uses automatic VAD, tuned so a learner's pause is not an interruption", () => {
    const detection = debateConfig({ topic: TOPIC }).realtimeInputConfig
      ?.automaticActivityDetection;
    assert.notEqual(detection?.disabled, true, "the examiner must be able to reply");
    // The documented floor is 500 ms, tuned for native speakers. A B2 candidate
    // searching for a word pauses far longer and must not be talked over.
    assert.ok(
      (detection?.silenceDurationMs ?? 0) >= 1000,
      "silence threshold leaves room to think",
    );
  });

  it("makes the examiner adversarial", () => {
    const instruction = String(debateConfig({ topic: TOPIC }).systemInstruction);
    assert.ok(instruction.includes("DÉBAT"));
    assert.ok(instruction.includes("avocat du diable"));
  });

  it("tells the examiner to carry on through a reconnection, not restart", () => {
    // Without this the resumed examiner greets the candidate again mid-débat,
    // which is exactly what makes a reconnect feel like a new exam.
    const instruction = String(debateConfig({ topic: TOPIC }).systemInstruction);
    assert.ok(instruction.includes("interrompue"));
    assert.ok(instruction.includes("sans le redémarrer"));
  });
});

describe("both phases, because the exam outlasts a connection", () => {
  for (const phase of ["monologue", "debate"] as const) {
    it(`${phase}: requests session resumption handles`, () => {
      const config = liveConfigForPhase(phase, { topic: TOPIC });
      assert.ok(
        config.sessionResumption,
        "without this field the server issues no handles and a reconnect restarts the exam",
      );
    });

    it(`${phase}: enables sliding-window context compression`, () => {
      // Lifts the 15-minute audio-only session cap, which a 7 + 13 minute exam
      // would otherwise hit.
      const config = liveConfigForPhase(phase, { topic: TOPIC });
      assert.ok(config.contextWindowCompression?.slidingWindow);
    });

    it(`${phase}: passes a resumption handle through when reconnecting`, () => {
      const config = liveConfigForPhase(phase, { topic: TOPIC, resumptionHandle: "handle-123" });
      assert.equal(config.sessionResumption?.handle, "handle-123");
    });

    it(`${phase}: speaks French`, () => {
      const config = liveConfigForPhase(phase, { topic: TOPIC });
      assert.equal(config.speechConfig?.languageCode, "fr-FR");
    });
  }
});

describe("the development examiner-prompt override (#148)", () => {
  const OVERRIDE = "Tu es un examinateur bien plus exigeant.";

  it("replaces the built instruction, in both phases", () => {
    for (const phase of ["monologue", "debate"] as const) {
      const config = liveConfigForPhase(phase, { topic: TOPIC, instructionOverride: OVERRIDE });
      assert.equal(String(config.systemInstruction), OVERRIDE);
    }
  });

  it("builds the shipped instruction when no override is given", () => {
    // The ordinary path, and the only one a production mint can take.
    const config = liveConfigForPhase("debate", { topic: TOPIC });
    assert.match(String(config.systemInstruction), /examinateur/i);
    assert.notEqual(String(config.systemInstruction), OVERRIDE);
  });

  it("reaches the instruction and nothing else", () => {
    // The transport is what makes a monologue a monologue: VAD disabled, no
    // turn boundary, so the examiner is structurally unable to interrupt. A
    // prompt experiment must not be able to switch that off by accident.
    const plain = liveConfigForPhase("monologue", { topic: TOPIC });
    const overridden = liveConfigForPhase("monologue", {
      topic: TOPIC,
      instructionOverride: OVERRIDE,
    });
    assert.deepEqual(
      { ...overridden, systemInstruction: undefined },
      { ...plain, systemInstruction: undefined },
    );
    assert.deepEqual(overridden.realtimeInputConfig, {
      automaticActivityDetection: { disabled: true },
    });
  });
});
