import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devToolsEnabled } from "./dev-tools";

/**
 * The rule that decides whether a build carries a way to write an exam
 * transcript without speaking, and to tell the server how long a phase lasted.
 *
 * The one case that must never regress is production. Everything else is a
 * convenience; that one is the boundary.
 */
describe("where the exam's development tooling is available", () => {
  it("is OFF on a Vercel production deployment, whatever else is set", () => {
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: "production" }), false);
    assert.equal(
      devToolsEnabled({ nodeEnv: "production", vercelEnv: "production", flag: "1" }),
      false,
      "the flag cannot reach past it",
    );
    assert.equal(
      devToolsEnabled({ nodeEnv: "development", vercelEnv: "production" }),
      false,
      "nor can a local-looking NODE_ENV",
    );
  });

  it("is on for staging and previews, with nothing to configure", () => {
    // Vercel reports both as "preview". This is what changed: it used to need
    // NEXT_PUBLIC_DEV_TOOLS=1, which is inlined at build time and so did
    // nothing until the next build — indistinguishable from a broken flag.
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: "preview" }), true);
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: "development" }), true);
  });

  it("is on for local development and under the test runner", () => {
    assert.equal(devToolsEnabled({ nodeEnv: "development" }), true);
    assert.equal(devToolsEnabled({ nodeEnv: "test" }), true);
    assert.equal(devToolsEnabled({}), true, "no NODE_ENV at all is a script, not a deploy");
  });

  it("treats an empty Vercel environment as no Vercel at all", () => {
    // `next.config.ts` inlines "" off Vercel, and "" must not read as an
    // environment named "" — which would turn this on for any production build
    // anywhere.
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: "" }), false);
    assert.equal(devToolsEnabled({ nodeEnv: "development", vercelEnv: "" }), true);
  });

  it("still lets a non-Vercel production host ask for it by name", () => {
    assert.equal(devToolsEnabled({ nodeEnv: "production" }), false, "off unless asked");
    assert.equal(devToolsEnabled({ nodeEnv: "production", flag: "1" }), true);
  });

  it('treats anything but "1" as off, rather than as truthy', () => {
    // "true", "0" and "" are all things people type into a dashboard field.
    for (const flag of ["true", "yes", "0", "", "01", " 1"]) {
      assert.equal(
        devToolsEnabled({ nodeEnv: "production", flag }),
        false,
        `${JSON.stringify(flag)} should not switch this on`,
      );
    }
  });
});
