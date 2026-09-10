/**
 * Mock a package under both of the builds it ships.
 *
 * `mock.module` keys on the resolved file, and the resolver that answers is not
 * the one that will be asked later: this project has no `"type": "module"`, so
 * tsx compiles every `.ts` to CommonJS and the module under test's imports
 * arrive as `require`. `mock.module("@clerk/nextjs/server")` resolves through
 * the `import` condition and mocks `dist/esm/...`, while the module under test
 * then loads the untouched `dist/cjs/...` — real Clerk, reaching for real
 * request headers.
 *
 * So both are registered. Packages that ship one file for both conditions —
 * `next/navigation`, `server-only` — resolve to the same URL twice and the
 * second registration is refused; that is the expected case, not a failure.
 *
 * Every call must run before the module under test is loaded, which is why the
 * tests that use this import their subject dynamically, inside `before`.
 *
 * `mock.module` needs `--experimental-test-module-mocks`, which is why
 * `test:unit` carries the flag.
 */

import { mock } from "node:test";
import { pathToFileURL } from "node:url";

export function mockPackage(specifier: string, namedExports: Record<string, unknown>) {
  mock.module(specifier, { namedExports });
  try {
    mock.module(pathToFileURL(require.resolve(specifier)).href, { namedExports });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_INVALID_STATE") throw error;
  }
}
