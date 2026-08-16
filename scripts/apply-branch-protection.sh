#!/usr/bin/env bash
#
# Applies the branch protection rules for main / staging / develop.
#
# WHY THIS IS A SCRIPT AND NOT ALREADY APPLIED
# --------------------------------------------
# The GitHub API refuses both classic branch protection and rulesets on a
# private repository on the Free plan:
#
#   403  "Upgrade to GitHub Pro or make this repository public to enable
#         this feature."
#
# So the rules live here, reviewable in the diff, ready to apply the moment the
# repository is public or the account is on Pro. Run it then:
#
#   bash scripts/apply-branch-protection.sh
#
# Requires: gh CLI, authenticated with admin rights on the repository.
# Re-running is safe — PUT replaces the rule wholesale.

set -euo pipefail

REPO="${REPO:-wafaezouiten/delf-oral-gemini}"

# The status checks that must be green. A context is the *check name*, which for
# a GitHub Actions job is its `name:` (or its job id when un-named) — not the
# "Workflow / Job" label the pull request page displays. Rename a job and you
# must rename it here, or the rule waits forever on a check that never reports.
#
# Deliberately excluded:
#   "claude-review"         — advisory. A review comment is not a pass/fail gate,
#                             and the job skips until CLAUDE_CODE_OAUTH_TOKEN exists.
#   "Codebase Intelligence" — Fallow is report-only by design; it never fails.
#   "Vercel", "Vercel Preview Comments"
#                           — the deployment reports its own status; requiring it
#                             couples merges to a third-party service being up.
#
# "GitGuardian Security Checks" is included, but it only starts reporting once
# the GitGuardian GitHub App is installed on the repository. Drop it from this
# list if you apply protection before installing the app, or every pull request
# will sit waiting for a check that cannot arrive.
CHECKS='["Lint, typecheck, unit tests & build","GitGuardian Security Checks"]'

protect() {
  local branch="$1" enforce_admins="$2" strict="$3"

  echo "→ $branch"
  gh api -X PUT "repos/${REPO}/branches/${branch}/protection" \
    --input - <<JSON >/dev/null
{
  "required_status_checks": {
    "strict": ${strict},
    "contexts": ${CHECKS}
  },
  "enforce_admins": ${enforce_admins},
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
}

# develop  — require a pull request, require CI to pass.
#            Not strict: feature branches need not rebase onto every merge.
protect develop false false

# staging  — require a pull request, require all checks, and require the branch
#            to be up to date with staging before merging (strict), so a
#            promotion is tested against exactly what it will become.
protect staging false true

# main     — same as staging, plus enforce_admins: nobody, including the owner,
#            pushes directly. Production only ever moves through a pull request.
protect main true true

echo
echo "Applied. Verify with:"
echo "  gh api repos/${REPO}/branches/main/protection --jq '{checks: .required_status_checks.contexts, admins: .enforce_admins.enabled}'"
echo
echo "NOTE: required_approving_review_count is 0 — GitHub does not let you approve"
echo "your own pull request, so a non-zero count would deadlock a solo repository."
echo "Raise it to 1 for staging and main as soon as there is a second reviewer."
