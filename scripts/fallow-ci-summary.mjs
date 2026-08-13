// Parses Fallow's machine-readable output into CI-friendly values.
//
// Ported verbatim from the company's DELF repository, except that the trunk
// fallbacks are `develop` rather than `main`.
//
// Usage:
//   node scripts/fallow-ci-summary.mjs <head-json> <head-badge> [audit-json] [base-json] [base-badge]
//
// - <head-json>: `fallow --format json --quiet` run on the PR/branch HEAD
// - <head-badge>: `fallow health --format badge --quiet` on HEAD (for the grade)
// - [audit-json]: `fallow audit --format json --quiet` — PR-scoped introduced/inherited
// - [base-json]: `fallow --format json --quiet` run on the merge-base (branch point)
// - [base-badge]: `fallow health --format badge --quiet` on the merge-base (for the grade delta)
//
// With [base-json] we can show a whole-project Before/After/Change delta, which
// surfaces issues the PR REMOVED (the audit's introduced/inherited view is
// forward-only and cannot show removals).
//
// Prints `key=value` lines on stdout (append to $GITHUB_OUTPUT) and writes a
// markdown block to fallow-report.md. REPORT-ONLY: always exits 0.

import { readFileSync, writeFileSync } from "node:fs";

const [jsonPath, badgePath, auditPath, basePath, baseBadgePath] = process.argv.slice(2);

// `fallow health --format badge` aria-label is `fallow: <grade> (<score>)`.
function parseBadge(svg) {
  const m = svg.match(/fallow:\s*([A-F][+-]?)\s*\((\d+)\)/i);
  return { grade: m ? m[1] : null, score: m ? Number(m[2]) : null };
}

function safeRead(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeParse(path) {
  try {
    return JSON.parse(safeRead(path));
  } catch {
    return null;
  }
}

// Pull the three issue counts + maintainability out of a combined `fallow` run.
function metrics(combined) {
  return {
    deadcode: combined?.check?.summary?.total_issues ?? null,
    dupes: combined?.dupes?.stats?.clone_groups ?? null,
    complexity: combined?.health?.summary?.functions_above_threshold ?? null,
    maintainability: combined?.health?.summary?.average_maintainability ?? null,
    analyzed: combined?.health?.summary?.functions_analyzed ?? null,
    dupPct: combined?.dupes?.stats?.duplication_percentage ?? null,
  };
}

// ── HEAD (current branch) ───────────────────────────────────────────────
const head = safeParse(jsonPath);
const parsed = head !== null;
const H = metrics(head);

const headBadge = parseBadge(safeRead(badgePath));
const healthGrade = headBadge.grade ?? "n/a";
const healthScore = headBadge.score ?? "n/a";

// ── BASE (merge-base) for the Before/After delta ────────────────────────
const base = safeParse(basePath);
const hasBase = base !== null;
const B = metrics(base);
const baseBadge = parseBadge(safeRead(baseBadgePath));

// ── PR-scoped attribution (introduced vs inherited) ─────────────────────
const audit = safeParse(auditPath);
const auditParsed = audit !== null;
const attribution = audit?.attribution ?? {};
const introducedTotal =
  (attribution.dead_code_introduced ?? 0) +
  (attribution.complexity_introduced ?? 0) +
  (attribution.duplication_introduced ?? 0);
const verdict = audit?.verdict ?? "n/a";
const changedFiles = audit?.changed_files_count ?? "n/a";
const baseRef = audit?.base_ref ?? "origin/develop";

// Copy-paste command for devs to reproduce the PR-scoped findings locally.
const fallowVersion = process.env.FALLOW_VERSION || "2.86.0";
const baseBranch =
  process.env.GITHUB_BASE_REF ||
  (typeof baseRef === "string" ? baseRef.replace(/^origin\//, "") : "develop");
const reproduceCmd = `git fetch origin ${baseBranch} && pnpm dlx fallow@${fallowVersion} audit --base origin/${baseBranch}`;

// ── GITHUB_OUTPUT scalars ───────────────────────────────────────────────
const fields = {
  parsed: String(parsed),
  maintainability: String(H.maintainability ?? "n/a"),
  health_grade: healthGrade,
  health_score: healthScore,
  deadcode: String(H.deadcode ?? "n/a"),
  dupes: String(H.dupes ?? "n/a"),
  complexity: String(H.complexity ?? "n/a"),
  audit_parsed: String(auditParsed),
  introduced_total: String(introducedTotal),
  verdict: String(verdict),
  has_base: String(hasBase),
};
for (const [k, v] of Object.entries(fields)) process.stdout.write(`${k}=${v}\n`);

// ── Markdown report ─────────────────────────────────────────────────────
// Render the "Change" cell for one metric. `lowerBetter` flips the polarity:
// fewer issues is good (green); a higher maintainability score is good.
function changeCell(before, after, { lowerBetter, decimals = 0 }) {
  if (before == null || after == null) return "—";
  const delta = after - before;
  if (delta === 0) return "—";
  const improved = lowerBetter ? delta < 0 : delta > 0;
  const mag = Math.abs(delta).toFixed(decimals);
  if (lowerBetter) {
    return improved ? `✅ ${mag} removed` : `⚠️ ${mag} added`;
  }
  const signed = `${delta > 0 ? "+" : "−"}${mag}`;
  return improved ? `✅ ${signed}` : `⚠️ ${signed}`;
}

function fmt(v, decimals = 0) {
  if (v == null) return "n/a";
  return decimals ? Number(v).toFixed(decimals) : String(v);
}

// Render a parsed badge as "C (66)", or "n/a" when unavailable.
function gradeCell(badge) {
  return badge.grade != null ? `${badge.grade} (${badge.score})` : "n/a";
}

const lines = [];

if (auditParsed) {
  const clean = introducedTotal === 0;
  lines.push(
    `**🔺 Introduced by this PR:** ${clean ? "none 🎉" : `${introducedTotal} new finding(s)`} ` +
      `in ${changedFiles} changed file(s) vs \`${baseRef}\` — audit verdict \`${verdict}\`.`,
    "",
  );
}

if (parsed && hasBase) {
  // Before/After/Change — the view that surfaces removed issues.
  lines.push(
    `### 📊 Impact vs \`${baseBranch}\``,
    "",
    "| Metric | Before | After | Change |",
    "|--------|:------:|:-----:|:------:|",
    `| Health score | ${gradeCell(baseBadge)} | ${gradeCell(headBadge)} | ${changeCell(baseBadge.score, headBadge.score, { lowerBetter: false })} |`,
    `| Maintainability (avg) | ${fmt(B.maintainability, 1)} | ${fmt(H.maintainability, 1)} | ${changeCell(B.maintainability, H.maintainability, { lowerBetter: false, decimals: 1 })} |`,
    `| Dead-code issues | ${fmt(B.deadcode)} | ${fmt(H.deadcode)} | ${changeCell(B.deadcode, H.deadcode, { lowerBetter: true })} |`,
    `| Duplicate clone groups | ${fmt(B.dupes)} | ${fmt(H.dupes)} | ${changeCell(B.dupes, H.dupes, { lowerBetter: true })} |`,
    `| Complexity hotspots | ${fmt(B.complexity)} | ${fmt(H.complexity)} | ${changeCell(B.complexity, H.complexity, { lowerBetter: true })} |`,
    "",
    "_Report-only — does not affect the build status._",
    "",
  );
} else if (parsed) {
  // No base to compare against (e.g. push events) — show current values only.
  lines.push(
    "### 📊 Whole project",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Maintainability (avg) | ${fmt(H.maintainability, 1)} |`,
    `| Health score | ${healthGrade} (${healthScore}) |`,
    `| Dead-code issues | ${fmt(H.deadcode)} |`,
    `| Duplicate clone groups | ${fmt(H.dupes)} |`,
    `| Complexity hotspots | ${fmt(H.complexity)} of ${fmt(H.analyzed)} functions above threshold |`,
    "",
    "_Report-only — does not affect the build status._",
    "",
  );
} else {
  lines.push("⚠️ Could not parse Fallow output.", "");
}

if (auditParsed) {
  lines.push(
    "**🔍 Reproduce locally** — copy-paste to drill into the findings:",
    "",
    "```bash",
    reproduceCmd,
    "```",
    "",
    "> ℹ️ The command also lists **pre-existing, project-wide findings** (e.g. unused",
    "> dependencies) that this PR didn't cause. To see only your PR's impact, use the",
    "> **Change** column above or the `✓ No issues in N changed files` line.",
    "",
  );
}

writeFileSync("fallow-report.md", lines.join("\n"));
