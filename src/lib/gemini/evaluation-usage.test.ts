import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MediaModality } from "@google/genai";

import { billedOutputTokens, readEvaluationUsage } from "./evaluation-usage";

describe("reading a correction's token usage", () => {
  it("reads the four counts the API reports", () => {
    const usage = readEvaluationUsage({
      promptTokenCount: 2209,
      candidatesTokenCount: 447,
      thoughtsTokenCount: 1354,
      totalTokenCount: 4010,
    });

    assert.equal(usage.promptTokens, 2209);
    assert.equal(usage.responseTokens, 447);
    assert.equal(usage.thoughtsTokens, 1354);
    assert.equal(usage.totalTokens, 4010);
  });

  it("reports nothing rather than zero when the response carried no usage", () => {
    const usage = readEvaluationUsage(undefined);

    // The distinction this module exists for: a cost computed from these is
    // visibly incomplete, where zeros would make a real call look free.
    assert.deepEqual(usage, {
      promptTokens: null,
      responseTokens: null,
      thoughtsTokens: null,
      totalTokens: null,
      audioPromptTokens: null,
    });
  });

  it("keeps a reported zero as a zero", () => {
    const usage = readEvaluationUsage({ thoughtsTokenCount: 0, promptTokenCount: 1200 });

    // A model that did no thinking reported 0, which is a measurement. Coercing
    // it to null would lose the difference between "did not think" and "did not
    // say".
    assert.equal(usage.thoughtsTokens, 0);
    assert.equal(usage.promptTokens, 1200);
  });

  it("finds the audio slice among the prompt's modalities", () => {
    const usage = readEvaluationUsage({
      promptTokenCount: 41_000,
      promptTokensDetails: [
        { modality: MediaModality.TEXT, tokenCount: 1_400 },
        { modality: MediaModality.AUDIO, tokenCount: 39_600 },
      ],
    });

    assert.equal(usage.audioPromptTokens, 39_600);
  });

  it("reports no audio tokens for a text-mode correction", () => {
    const usage = readEvaluationUsage({
      promptTokenCount: 2000,
      promptTokensDetails: [{ modality: MediaModality.TEXT, tokenCount: 2000 }],
    });

    assert.equal(usage.audioPromptTokens, null);
  });
});

describe("what a correction is billed for as output", () => {
  it("adds the thinking to the answer", () => {
    const billed = billedOutputTokens({
      promptTokens: 2209,
      responseTokens: 447,
      thoughtsTokens: 1354,
      totalTokens: 4010,
      audioPromptTokens: null,
    });

    // 447 alone is what the correction returned; 1801 is what it cost. Comparing
    // the first against another system's total output is the mistake this
    // function exists to prevent.
    assert.equal(billed, 1801);
  });

  it("counts an answer whose thinking was not reported", () => {
    const billed = billedOutputTokens({
      promptTokens: 100,
      responseTokens: 447,
      thoughtsTokens: null,
      totalTokens: null,
      audioPromptTokens: null,
    });

    assert.equal(billed, 447);
  });

  it("reports nothing when neither figure arrived", () => {
    const billed = billedOutputTokens({
      promptTokens: null,
      responseTokens: null,
      thoughtsTokens: null,
      totalTokens: null,
      audioPromptTokens: null,
    });

    assert.equal(billed, null);
  });
});
