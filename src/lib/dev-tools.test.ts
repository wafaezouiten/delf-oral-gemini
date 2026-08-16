import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devToolsEnabled } from "./dev-tools";

/**
 * The rule that decides whether a build carries a way to write an exam
 * transcript without speaking, and to tell the server how long a phase lasted.
 *
 * Every case below is about an environment somebody could plausibly deploy, and
 * the ones that matter most are the ones that must answer false.
 */
describe("where the exam's development tooling is available", () => {
  it("is on for local development", () => {
    assert.equal(devToolsEnabled({ nodeEnv: "development" }), true);
  });

  it("is on under the test runner, so the suite exercises the real paths", () => {
    assert.equal(devToolsEnabled({ nodeEnv: "test" }), true);
  });

  it("is OFF for a built artefact that has not asked for it", () => {
    // The default for staging, for every preview, and for production alike.
    assert.equal(devToolsEnabled({ nodeEnv: "production" }), false);
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: "preview" }), false);
  });

  it("is on for a deployment that asks by name", () => {
    assert.equal(
      devToolsEnabled({ nodeEnv: "production", vercelEnv: "preview", flag: "1" }),
      true,
      "staging, with NEXT_PUBLIC_DEV_TOOLS=1 set on that environment",
    );
  });

  it("refuses production even when the flag is set there by mistake", () => {
    // The whole point of the veto. Somebody adding the variable at the project
    // level rather than to one environment must not hand every candidate a way
    // to type their own exam and claim their own duration.
    assert.equal(
      devToolsEnabled({ nodeEnv: "production", vercelEnv: "production", flag: "1" }),
      false,
    );
  });

  it("refuses production even in a local-looking build", () => {
    // `vercel dev` against the production environment, and anything else that
    // pairs a non-production NODE_ENV with a production deployment.
    assert.equal(devToolsEnabled({ nodeEnv: "development", vercelEnv: "production" }), false);
  });

  it("treats anything but \"1\" as off, rather than as truthy", () => {
    // "true", "0" and "" are all things people type into a dashboard field.
    for (const flag of ["true", "yes", "0", "", "01", " 1"]) {
      assert.equal(
        devToolsEnabled({ nodeEnv: "production", flag }),
        false,
        `${JSON.stringify(flag)} should not switch this on`,
      );
    }
  });

  it("does not infer permission from an unknown environment", () => {
    // A host that sets neither variable gets the default, which is off.
    assert.equal(devToolsEnabled({ nodeEnv: "production", vercelEnv: undefined }), false);
    assert.equal(devToolsEnabled({}), true, "no NODE_ENV at all is a local script, not a deploy");
  });
});
