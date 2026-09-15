import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { examinerRow, micRow, retentionDetail } from "./preflight";

const choices = [
  { id: "gemini-a", label: "Examinateur A", detail: "Le défaut." },
  { id: "gemini-b", label: "Examinateur B", detail: "Plus insistant." },
];

describe("the pre-flight card's rows", () => {
  it("offers the microphone test, shows the bars while it runs, and the check once it passed", () => {
    assert.deepEqual(micRow("idle"), {
      detail: "Vérifiez votre niveau d'entrée.",
      control: "button",
      buttonLabel: "Tester",
    });
    assert.equal(micRow("testing").control, "bars");
    assert.equal(micRow("tested").control, "check");
    assert.equal(micRow("tested").detail, "Micro autorisé, vous êtes prêt.");
  });

  it("offers the test again, in those words, after the microphone was refused", () => {
    assert.deepEqual(micRow("failed"), {
      detail: "Autorisez le micro, puis réessayez.",
      control: "button",
      buttonLabel: "Réessayer",
    });
  });

  it("describes the chosen examiner, and says so while the choice is being written", () => {
    assert.deepEqual(examinerRow("gemini-b", false, false, choices), {
      detail: "Plus insistant.",
      unlisted: false,
    });
    assert.equal(examinerRow("gemini-b", true, false, choices).detail, "Enregistrement du choix…");
  });

  it("keeps showing the examiner the sitting will hear when the write failed", () => {
    const row = examinerRow("gemini-b", false, true, choices);
    assert.match(row.detail, /n'a pas pu être enregistré/);
  });

  it("shows an examiner the catalogue no longer lists under its raw id (#99)", () => {
    assert.deepEqual(examinerRow("gemini-retired", false, false, choices), {
      detail: "gemini-retired",
      unlisted: true,
    });
  });

  it("says what the retention switch will do", () => {
    assert.match(retentionDetail(true), /sera conservée/);
    assert.match(retentionDetail(false), /ne sera pas conservée/);
  });
});
