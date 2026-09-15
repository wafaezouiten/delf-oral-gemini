import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zeroCriteria, type DashboardSitting } from "./dashboard-view";
import { historiqueView } from "./historique-view";

function sitting(overrides: Partial<DashboardSitting> = {}): DashboardSitting {
  return {
    examId: 1,
    topicSlug: "teletravail",
    topicTitle: "Le télétravail",
    outcome: "corrected",
    score25: 15,
    meetsFloor: true,
    mode: "audio",
    criteria: zeroCriteria(),
    spokenSeconds: 600,
    phase: "finished",
    endedAt: new Date("2026-08-16T10:00:00Z"),
    archivedAt: null,
    recordings: [],
    ...overrides,
  };
}
const walkOut = sitting({
  examId: 2,
  outcome: "abandoned",
  score25: 0,
  mode: null,
  phase: "monologue",
});
const archived = sitting({ examId: 3, archivedAt: new Date("2026-08-01T00:00:00Z") });

describe("the historique's view", () => {
  it("is empty only when the record and the archive both are", () => {
    assert.equal(historiqueView([]).empty, true);
    assert.equal(historiqueView([archived]).empty, false, "an archive alone is not nothing");
  });

  it("splits the record from the archive on the flag, keeping the order", () => {
    const view = historiqueView([sitting(), archived, walkOut]);
    assert.deepEqual(
      view.record.map((row) => row.examId),
      [1, 2],
    );
    assert.deepEqual(
      view.archived.map((row) => row.examId),
      [3],
    );
  });

  it("counts the current record in the summary, walk-outs included, and agrees in number", () => {
    assert.equal(
      historiqueView([sitting()]).summary,
      "1 épreuve à votre actif. Une épreuve en cours n'y figure pas.",
    );
    assert.equal(
      historiqueView([sitting(), walkOut, archived]).summary,
      "2 épreuves à votre actif, dont 1 abandonnée et comptée 0/25. Une épreuve en cours n'y figure pas.",
    );
    assert.equal(
      historiqueView([walkOut, sitting({ ...walkOut, examId: 4 }), sitting()]).summary,
      "3 épreuves à votre actif, dont 2 abandonnées et comptées 0/25. Une épreuve en cours n'y figure pas.",
    );
  });

  it("counts a record that a reset emptied as zero, under the archive", () => {
    const view = historiqueView([archived]);
    assert.equal(view.summary, "0 épreuve à votre actif. Une épreuve en cours n'y figure pas.");
    assert.equal(view.record.length, 0);
  });

  it("writes the archive's note in the singular and the plural, or not at all", () => {
    assert.equal(historiqueView([sitting()]).archiveNote, null);
    assert.equal(
      historiqueView([archived]).archiveNote,
      "1 épreuve d'avant votre réinitialisation. Elle ne compte plus dans vos statistiques, et sa correction reste consultable.",
    );
    assert.equal(
      historiqueView([archived, { ...archived, examId: 5 }]).archiveNote,
      "2 épreuves d'avant votre réinitialisation. Elles ne comptent plus dans vos statistiques, et leurs corrections restent consultables.",
    );
  });
});
