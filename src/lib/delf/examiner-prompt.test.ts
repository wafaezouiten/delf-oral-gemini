import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXAMINER_PROMPT_VERSION,
  buildExaminerInstruction,
  closingInstruction,
  examinerOpeningLine,
} from "./examiner-prompt";
import type { OralTopic } from "./topics";
import { ORAL_TOPICS } from "./topics";

const TOPIC: OralTopic = ORAL_TOPICS[0];

describe("examiner prompt", () => {
  it("is version-controlled and versioned", () => {
    // The reference implementation kept this text in a vendor dashboard: not in
    // git, not diffable, not reviewable. Owning it here is the point, and the
    // version is stamped onto every evaluation so a result can be traced back.
    assert.match(EXAMINER_PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("never uses an em dash or en dash in text the examiner will speak", () => {
    // Dashes read as machine-written in French, and this text is both spoken
    // aloud and echoed into the transcript the candidate reads afterwards.
    for (const phase of ["monologue", "debate"] as const) {
      const text = [
        buildExaminerInstruction(phase, TOPIC),
        examinerOpeningLine(phase),
        closingInstruction(phase),
      ].join("\n");
      assert.ok(!text.includes("—"), `${phase} instruction contains an em dash`);
      assert.ok(!text.includes("–"), `${phase} instruction contains an en dash`);
    }
  });

  it("keeps the examiner in role in both phases", () => {
    for (const phase of ["monologue", "debate"] as const) {
      const instruction = buildExaminerInstruction(phase, TOPIC);
      assert.ok(instruction.includes("UNIQUEMENT en français"));
      assert.ok(instruction.includes("PAS un assistant"), "must not behave as a chatbot");
      assert.ok(instruction.includes("n'évalues JAMAIS à voix haute"));
    }
  });

  it("forbids interruption during the monologue", () => {
    const instruction = buildExaminerInstruction("monologue", TOPIC);
    assert.ok(instruction.includes("Ne l'interromps sous AUCUN prétexte"));
    // Backchannelling is the specific failure a conversational model falls into.
    assert.ok(instruction.includes("d'accord"), "explicitly forbids backchannelling");
  });

  it("requires the debate to quote a real argument rather than invent one", () => {
    const instruction = buildExaminerInstruction("debate", TOPIC);
    assert.ok(instruction.includes("Ne parle jamais d'un argument qu'il n'a pas donné"));
    assert.ok(instruction.includes("exemples NOUVEAUX"));
  });

  it("tells the closing line not to reveal a grade", () => {
    for (const phase of ["monologue", "debate"] as const) {
      assert.ok(closingInstruction(phase).includes("N'évalue pas"));
    }
  });

  it("carries the selected subject into the instruction", () => {
    for (const topic of ORAL_TOPICS) {
      const instruction = buildExaminerInstruction("monologue", topic);
      assert.ok(instruction.includes(topic.title));
      assert.ok(instruction.includes(topic.document));
    }
  });
});
