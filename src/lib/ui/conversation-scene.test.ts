import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { progressPercent, turnAnnouncement } from "./conversation-scene";

describe("the scene's progress bar", () => {
  it("is the part's elapsed share in whole percents, held at the end", () => {
    assert.equal(progressPercent(0, 600), 0);
    assert.equal(progressPercent(150, 600), 25);
    assert.equal(progressPercent(599, 600), 100, "rounds up at the end");
    assert.equal(progressPercent(700, 600), 100, "never past the end");
  });

  it("draws nothing for a part with no length", () => {
    assert.equal(progressPercent(10, 0), 0);
  });
});

describe("what a screen reader hears about the floor", () => {
  const statuses = {
    examinerStatus: "Vous écoute attentivement.",
    candidateStatus: "Vous avez la parole",
  };

  it("names the examiner while they speak", () => {
    assert.equal(
      turnAnnouncement({
        ...statuses,
        examinerSpeaking: true,
        candidateRecording: false,
        examinerStatus: "L'examinateur intervient…",
      }),
      "L'examinateur parle. L'examinateur intervient…",
    );
  });

  it("hands the floor to the candidate while their microphone is live", () => {
    assert.equal(
      turnAnnouncement({ ...statuses, examinerSpeaking: false, candidateRecording: true }),
      "À vous de parler. Vous avez la parole",
    );
  });

  it("falls back to the examiner's status when nobody has the floor", () => {
    assert.equal(
      turnAnnouncement({
        ...statuses,
        examinerSpeaking: false,
        candidateRecording: false,
        examinerStatus: "Connexion en cours…",
      }),
      "Connexion en cours…",
    );
  });
});
