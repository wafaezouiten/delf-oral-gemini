import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findTopic } from "@/lib/delf/topics";

import { oralPageSubject } from "./oral-page";

const teletravail = findTopic("teletravail")!;

describe("which sujet the exam page opens on", () => {
  it("reads the sitting's own subject and examiner, whatever the query says", () => {
    const page = oralPageSubject(
      { topicSlug: "teletravail", examinerModel: "gemini-x" },
      { sujet: "autre-sujet" },
    );
    assert.equal(page?.topic, teletravail);
    assert.equal(page?.storedExaminerModel, "gemini-x");
  });

  it("falls back to the query string only where there is no row to disagree with", () => {
    const page = oralPageSubject(null, { sujet: "teletravail" });
    assert.equal(page?.topic, teletravail);
    assert.equal(page?.storedExaminerModel, null);
  });

  it("is a 404 for a subject the catalogue does not have, or none at all", () => {
    assert.equal(oralPageSubject(null, { sujet: "sujet-retire" }), null);
    assert.equal(oralPageSubject(null, {}), null);
    assert.equal(
      oralPageSubject(null, { sujet: ["a", "b"] }),
      null,
      "a repeated key is no subject",
    );
    assert.equal(oralPageSubject({ topicSlug: null, examinerModel: null }, {}), null);
  });
});
