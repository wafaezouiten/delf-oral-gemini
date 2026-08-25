import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVE_PROMPT_COPY,
  DEV_PROMPT_COPY,
  DEV_PROMPT_SUBMIT_COPY,
  MAX_EXAMINER_PROMPT_LENGTH,
  describePrompt,
  isPromptModified,
  normaliseExaminerPrompt,
  promptSubmitDisabled,
  promptSubmitState,
} from "./dev-examiner-prompt";

describe("normalising an edited prompt", () => {
  it("trims the ends", () => {
    assert.equal(normaliseExaminerPrompt("  Tu es examinateur.  \n"), "Tu es examinateur.");
  });

  it("leaves the interior exactly as typed", () => {
    // A system instruction is whitespace-sensitive in ways that matter to the
    // model: blank lines separate its blocks and the leading « - » of every
    // absolute rule is load-bearing. A normaliser that tidied would silently
    // edit the thing under test.
    const prompt = "RÈGLES :\n\n- Une règle.\n-   Une autre, mal alignée.";
    assert.equal(normaliseExaminerPrompt(prompt), prompt);
  });
});

describe("telling a modified prompt from the one in force", () => {
  it("ignores a difference that is only surrounding whitespace", () => {
    assert.equal(isPromptModified("  Tu es examinateur.  ", "Tu es examinateur."), false);
  });

  it("notices a changed instruction", () => {
    assert.equal(
      isPromptModified("Pose des questions plus exigeantes.", "Pose une question à la fois."),
      true,
    );
  });
});

describe("what « Appliquer le prompt » can do right now", () => {
  const DEFAULT = "Tu es un examinateur officiel du DELF B2.";
  const state = (over: Partial<Parameters<typeof promptSubmitState>[0]> = {}) =>
    promptSubmitState({
      draft: "Pose des questions plus exigeantes.",
      active: DEFAULT,
      loading: false,
      failed: false,
      ...over,
    });

  it("is ready when the draft says something new", () => {
    assert.equal(state(), "ready");
    assert.equal(promptSubmitDisabled("ready"), false);
  });

  it("waits for the prompt to arrive rather than looking pressable", () => {
    // The default text is not in the client bundle, on purpose. Until the
    // fetch lands there is nothing to apply and nothing to compare against.
    assert.equal(state({ loading: true }), "loading");
    assert.equal(promptSubmitDisabled("loading"), true);
  });

  it("says so when the prompt could not be loaded at all", () => {
    assert.equal(state({ failed: true }), "failed");
  });

  it("refuses an empty prompt, which would leave the session without an examiner", () => {
    assert.equal(state({ draft: "" }), "empty");
    assert.equal(state({ draft: "   \n\t" }), "empty");
  });

  it("refuses a prompt past the bound the token has to carry", () => {
    assert.equal(state({ draft: "x".repeat(MAX_EXAMINER_PROMPT_LENGTH + 1) }), "toolong");
    assert.equal(state({ draft: "x".repeat(MAX_EXAMINER_PROMPT_LENGTH) }), "ready");
  });

  it("has nothing to do when the draft is already in force", () => {
    // Pressing would restart the examiner to install the text it is running.
    assert.equal(state({ draft: DEFAULT }), "unchanged");
    assert.equal(state({ draft: `\n${DEFAULT}  ` }), "unchanged");
  });

  it("reports the load before the contents of a box it has not filled yet", () => {
    // Order matters only in that the more specific reason wins: telling
    // somebody their empty box cannot be applied, while the text that is about
    // to fill it is still in flight, describes the wrong problem.
    assert.equal(state({ draft: "", loading: true }), "loading");
    assert.equal(state({ draft: "", failed: true }), "failed");
  });

  it("explains itself exactly where explaining is worth something", () => {
    assert.equal(DEV_PROMPT_SUBMIT_COPY.ready.note, null);
    assert.match(DEV_PROMPT_SUBMIT_COPY.empty.note ?? "", /vide/);
    assert.match(DEV_PROMPT_SUBMIT_COPY.unchanged.note ?? "", /déjà/);
    assert.match(
      DEV_PROMPT_SUBMIT_COPY.toolong.note ?? "",
      new RegExp(String(MAX_EXAMINER_PROMPT_LENGTH)),
    );
    assert.equal(DEV_PROMPT_SUBMIT_COPY.ready.label, DEV_PROMPT_COPY.apply);
  });
});

describe("the panel's words", () => {
  it("names the examiner's prompt, never the candidate's answer", () => {
    // The distinction this whole panel exists to keep: it edits how the
    // EXAMINER behaves and never puts words in the candidate's mouth. Copy
    // that drifted towards « réponse du candidat » would be the old tool
    // wearing this one's title.
    assert.equal(DEV_PROMPT_COPY.title, "Prompt de l'examinateur");
    const words = Object.values(DEV_PROMPT_COPY).join(" ");
    assert.doesNotMatch(words, /réponse du candidat/i);
  });

  it("says when an applied prompt takes effect, in both situations", () => {
    // The one thing about this panel that cannot be worked out by using it:
    // Gemini fixes the instruction when a session opens, so applying either
    // restarts the examiner or waits for the next one.
    assert.match(DEV_PROMPT_COPY.restartWarning, /nouvelle session/);
    assert.match(DEV_PROMPT_COPY.restartWarning, /perd la mémoire/);
    assert.match(DEV_PROMPT_COPY.nextSessionNote, /prochaine session/);
  });

  it("distinguishes the shipped prompt from a dev one", () => {
    assert.notEqual(ACTIVE_PROMPT_COPY.default, ACTIVE_PROMPT_COPY.modified);
    assert.match(ACTIVE_PROMPT_COPY.modified, /dev/i);
  });
});

describe("the counter under the field", () => {
  it("counts the characters that would actually be sent", () => {
    assert.equal(describePrompt("  abc  "), "3 caractères");
  });

  it("keeps « caractère » singular, and reads zero for an empty box", () => {
    assert.equal(describePrompt("a"), "1 caractère");
    assert.equal(describePrompt("   "), "0 caractères");
  });
});
