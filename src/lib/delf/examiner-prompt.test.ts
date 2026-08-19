import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXAMINER_PROMPT_VERSION,
  buildExaminerInstruction,
  closingInstruction,
  examinerOpeningLine,
  presenceCheckInstruction,
  resumeDebateInstruction,
  silenceRelanceInstruction,
  timeRemainingInstruction,
} from "./examiner-prompt";
import type { OralTopic } from "./topics";
import { ORAL_TOPICS } from "./topics";

const TOPIC: OralTopic = ORAL_TOPICS[0];

describe("examiner prompt", () => {
  it("is version-controlled and versioned", () => {
    // The reference implementation kept this text in a vendor dashboard: not in
    // git, not diffable, not reviewable. Owning it here is the point. Nothing
    // reads the version yet — the `prompt_version` on a correction is the
    // CORRECTOR's, `EVAL_PROMPT_VERSION` — so this asserts the shape and the
    // discipline of bumping it, not a traceability the schema does not have.
    assert.match(EXAMINER_PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("never uses an em dash or en dash in text the examiner will speak", () => {
    // Dashes read as machine-written in French, and this text is both spoken
    // aloud and echoed into the transcript the candidate reads afterwards.
    for (const phase of ["monologue", "debate"] as const) {
      const text = [
        buildExaminerInstruction(phase, TOPIC),
        // Null for the monologue since #37 — the greeting it used to speak is now
        // a recorded consigne, and `announcements.test.ts` holds it to the same
        // no-dash rule.
        examinerOpeningLine(phase) ?? "",
        closingInstruction(phase),
      ].join("\n");
      assert.ok(!text.includes("—"), `${phase} instruction contains an em dash`);
      assert.ok(!text.includes("–"), `${phase} instruction contains an en dash`);
    }
    // Phase-free, because only the débat has them (#84, #85).
    for (const text of [
      silenceRelanceInstruction(),
      presenceCheckInstruction(),
      timeRemainingInstruction(7),
      resumeDebateInstruction(7),
    ]) {
      assert.ok(!text.includes("—"), "a silence directive contains an em dash");
      assert.ok(!text.includes("–"), "a silence directive contains an en dash");
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

  describe("what the examiner says into a silence (#84)", () => {
    it("asks for a relance on the substance rather than a script", () => {
      // The examiner's job at that moment is to push on what the candidate
      // actually said, so the words have to be the model's. A canned « Pouvez-vous
      // préciser ? » would be the one relance in the épreuve that ignores the
      // exchange it interrupts.
      const relance = silenceRelanceInstruction();
      assert.ok(relance.includes("Relance-le sur le fond"));
      assert.ok(!relance.includes("mot pour mot"), "it is a directive, not a line to read");
    });

    it("keeps the relance from turning into a reproach or an assessment", () => {
      const relance = silenceRelanceInstruction();
      assert.ok(relance.includes("Ne fais aucune remarque sur son silence"));
      assert.ok(relance.includes("ne lui demande pas s'il a compris"));
      assert.ok(relance.includes("n'évalue pas"));
    });

    it("fixes the wording of the presence check, because it is a technical check", () => {
      const check = presenceCheckInstruction();
      assert.ok(check.includes("mot pour mot"));
      assert.ok(check.includes("Vous m'entendez ?"));
    });
  });

  describe("who is allowed to end the épreuve (#85)", () => {
    it("forbids the examiner to conclude, dismiss or invent a part, in both phases", () => {
      // The observed failure: at 6:00 of a 13:00 débat the examiner announced a
      // third part of an épreuve that has two and told the candidate they could
      // leave. The app already refused to let that end the phase; what it had
      // never said is that the examiner must not say it.
      for (const phase of ["monologue", "debate"] as const) {
        const instruction = buildExaminerInstruction(phase, TOPIC);
        assert.ok(instruction.includes("EXACTEMENT deux parties"));
        assert.ok(instruction.includes("Il n'existe pas de troisième partie"));
        assert.ok(instruction.includes("quitter la salle"), "must not dismiss the candidate");
        assert.ok(
          instruction.includes("lorsqu'on te donne explicitement l'instruction de conclure"),
          "the closing directive is the only thing that ends a part",
        );
      }
    });

    it("keeps the clock the examiner is lent out of its mouth", () => {
      // The cue is sent through the same path as the closing line, so it makes
      // the model SPEAK. What it must not speak is the number.
      const identity = buildExaminerInstruction("debate", TOPIC);
      assert.ok(identity.includes("Tu ne parles JAMAIS du temps"));
      assert.ok(identity.includes("sans jamais la dire à voix haute"));

      const cue = timeRemainingInstruction(7);
      assert.ok(cue.includes("il reste environ 7 minutes"));
      assert.ok(cue.includes("à ne jamais prononcer"));
      assert.ok(cue.includes("Ne parle ni du temps"));
    });

    it("tells the débat it is the app that decides when it stops", () => {
      const instruction = buildExaminerInstruction("debate", TOPIC);
      assert.ok(instruction.includes("DURÉE :"));
      assert.ok(instruction.includes("Il reste toujours une objection à formuler"));
    });

    it("gives an examiner that has said goodbye somewhere to go", () => {
      // « Ne conclus pas » on its own leaves it with nothing to say next, and
      // silence is the dead end this is trying to get out of.
      const resume = resumeDebateInstruction(7);
      assert.ok(resume.includes("n'est PAS terminée"));
      assert.ok(resume.includes("environ 7 minutes"));
      assert.ok(resume.includes("Enchaîne immédiatement"));
      assert.ok(resume.includes("Ne t'excuse pas"), "an apology would be about the épreuve");
    });
  });

  it("carries the selected subject into the instruction", () => {
    for (const topic of ORAL_TOPICS) {
      const instruction = buildExaminerInstruction("monologue", topic);
      assert.ok(instruction.includes(topic.title));
      assert.ok(instruction.includes(topic.document));
    }
  });
});
