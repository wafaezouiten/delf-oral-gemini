import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readsAsClosing } from "./early-closing";
import {
  EXAMINER_PROMPT_VERSION,
  buildExaminerInstruction,
  closingInstruction,
  examinerOpeningLine,
  lastQuestionInstruction,
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
      // The second wording is a different string and is spoken as often as the
      // first (#101), so it answers to the same rule.
      silenceRelanceInstruction(2),
      presenceCheckInstruction(),
      timeRemainingInstruction(7),
      resumeDebateInstruction(7),
      resumeDebateInstruction(1, true),
      lastQuestionInstruction(),
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

    it("stops asking for a rephrasing once the relance is repeating itself (#101)", () => {
      // A relance that always said « reformule ta dernière question » would have
      // the model rephrase its own rephrasing, on a context window that is
      // sliding. From the second nudge on it is asked for a new question.
      const again = silenceRelanceInstruction(2);
      assert.ok(again.includes("pose une question NOUVELLE"));
      assert.ok(!again.includes("reformule autrement"), "the old ask is dropped, not repeated");
      assert.ok(again.includes("Ne reformule pas ce que tu viens de dire"));
    });

    it("keeps a repeated relance from turning into a reproach either", () => {
      // The constraints are the point of the wording, not decoration on the
      // first one: a model asked a third time is likelier, not less likely, to
      // remark on the silence.
      const again = silenceRelanceInstruction(2);
      assert.ok(again.includes("Ne fais aucune remarque sur son silence"));
      assert.ok(again.includes("ne lui demande pas s'il a compris"));
      assert.ok(again.includes("n'évalue pas"));
      assert.ok(!again.includes("mot pour mot"), "it is still a directive, not a line to read");
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

  describe("the last question and the call of time (#108)", () => {
    it("has the examiner announce the end aloud, and still without a number", () => {
      // The one moment the examiner may mention time out loud, and the
      // permission is exactly that wide: the approaching end, never the clock.
      const cue = lastQuestionInstruction();
      assert.ok(cue.includes("à voix haute"));
      assert.ok(cue.includes("dernière question"));
      assert.ok(cue.includes("aucun chiffre"));
    });

    it("keeps the announcement from becoming a goodbye", () => {
      // « La fin approche » is one goodbye away from #85's failure, so the
      // directive forbids every leave-taking move by name.
      const cue = lastQuestionInstruction();
      assert.ok(cue.includes("PAS encore terminée"));
      assert.ok(cue.includes("ne conclus pas"));
      assert.ok(cue.includes("ne prends pas congé"));
    });

    it("steers an example the early-closing watch will not mistake for a goodbye", () => {
      // The sentence the directive offers is what the model is likeliest to
      // parrot, and `readsAsClosing` reads every examiner turn. If the example
      // ever drifts onto that phrase list, the app would contradict the very
      // announcement it asked for — this is the test that holds the two files
      // apart.
      assert.equal(
        readsAsClosing(
          "Nous arrivons à la fin de cet entretien. Une dernière question : le télétravail est-il vraiment un progrès ?",
        ),
        false,
      );
    });

    it("carves the one exception out of the identity's time rule", () => {
      // Without the carve-out the model is asked to do the one thing its
      // absolute rules forbid, and an instruction-following model rightly
      // refuses its own directive.
      for (const phase of ["monologue", "debate"] as const) {
        const instruction = buildExaminerInstruction(phase, TOPIC);
        assert.ok(instruction.includes("Une seule exception"));
        assert.ok(instruction.includes("aucun chiffre, ni minutes ni secondes"));
      }
      // And the débat is told the announcement will be asked for, so it does
      // not volunteer one of its own at minute six.
      const debate = buildExaminerInstruction("debate", TOPIC);
      assert.ok(debate.includes("une instruction te demandera d'annoncer la dernière question"));
    });

    it("switches the goodbye recovery once the last question has been asked", () => {
      // A recovery demanding a fresh objection after « une dernière question »
      // is the app breaking its own promise through the examiner's mouth.
      const after = resumeDebateInstruction(1, true);
      assert.ok(after.includes("n'est PAS terminée"), "the goodbye is still contradicted");
      assert.ok(after.includes("Rebondis"));
      assert.ok(after.includes("sans poser de question entièrement nouvelle"));
      assert.ok(!after.includes("nouvelle objection"));
      assert.ok(after.includes("environ 1 minute de débat"), "and 1 minute agrees in number");
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
