import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cn } from "./class-names";

describe("cn", () => {
  it("joins the classes that survive", () => {
    assert.equal(cn("a", "b", "c"), "a b c");
  });

  it("drops every falsy branch, which is the whole point of it", () => {
    // `false` from a `condition &&`, `undefined` from an absent prop, `null`
    // from a lookup that missed. All three appear at call sites in this repo.
    assert.equal(cn("a", false, undefined, null, "b"), "a b");
  });

  it("returns an empty string rather than a stray space when nothing survives", () => {
    // A `className=" "` is not the same as no class attribute to a snapshot, and
    // it is the kind of difference that only ever shows up in a diff.
    assert.equal(cn(false, undefined), "");
  });
});
