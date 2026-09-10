import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Sibling checkouts, when two sessions work this repository at once. The
    // patterns above are anchored at the root, so a built worktree's own
    // `.next/types/*` is not covered by `.next/**` and was linted as source.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
