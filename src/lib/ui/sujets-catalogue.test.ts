import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { catalogueFacts, filterSujets, normalise, resultCount } from "./sujets-catalogue";

const sujets = [
  {
    slug: "teletravail",
    title: "Le télétravail",
    topic: { document: "Travailler depuis chez soi…" },
  },
  {
    slug: "velo",
    title: "La ville à vélo",
    topic: { document: "Les pistes cyclables se multiplient." },
  },
];

describe("searching the catalogue", () => {
  it("ignores accents and case", () => {
    assert.equal(normalise("  TÉLÉtravail "), "teletravail");
  });

  it("is the whole catalogue, in order, for an empty or blank query", () => {
    assert.equal(filterSujets(sujets, ""), sujets);
    assert.equal(filterSujets(sujets, "   "), sujets);
  });

  it("matches on the title or on a word of the document", () => {
    assert.deepEqual(
      filterSujets(sujets, "teletravail").map((s) => s.slug),
      ["teletravail"],
    );
    assert.deepEqual(
      filterSujets(sujets, "PISTES").map((s) => s.slug),
      ["velo"],
    );
    assert.deepEqual(filterSujets(sujets, "métro"), []);
  });

  it("counts the results aloud, and the catalogue when nothing is typed", () => {
    assert.equal(resultCount("", 2, 2), "2 sujets");
    assert.equal(resultCount("velo", 1, 2), "1 sujet sur 2");
    assert.equal(resultCount("e", 2, 2), "2 sujets sur 2");
    assert.equal(resultCount("zzz", 0, 2), "0 sujet sur 2");
  });

  it("states the catalogue's facts", () => {
    assert.deepEqual(catalogueFacts(6), ["6 sujets publiés", "Examinateur IA", "Correction /25"]);
  });
});
