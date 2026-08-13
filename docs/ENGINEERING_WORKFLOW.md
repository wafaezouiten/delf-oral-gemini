# Engineering workflow

The process this repository follows, reproduced from the company's DELF repository
(`delf-preps`) and its PR #429. The point of the reproduction is the process, not
only the application code: the same branch model, the same pull request shape, the
same gates before anything reaches production.

## Branch model

```text
main        production
 ↑          promoted from staging, by pull request only
staging     pre-production
 ↑          promoted from develop, by pull request only
develop     integration — the default branch, where phases land
 ↑
feature/*   one per issue, cut from develop
```

Rules:

- Cut every feature branch from `develop`. Name it `feature/<phase>-<slug>`, e.g.
  `feature/2-db-schema`.
- Merge feature branches into `develop` through a pull request. Never push to
  `develop` directly.
- Promote `develop` → `staging` and `staging` → `main` with a pull request each.
  A promotion carries no new commits of its own.
- `develop` is the repository's default branch, so new pull requests target it
  without anyone having to remember to retarget.

Cutting a branch:

```bash
git fetch origin && git switch -c feature/4-gemini-session origin/develop
```

Promoting:

```bash
gh pr create --base staging --head develop --title "chore: promote develop to staging"
```

> **Naming note.** This repository originally called the integration branch `dev`.
> It was renamed to `develop` to match the company repository; GitHub retargeted
> the open pull request automatically. If you have a stale local clone:
> `git branch -m dev develop && git fetch --prune && git branch -u origin/develop develop`.

## Issues, branches, pull requests

Every phase has an issue, a branch and a pull request. GitHub numbers issues and
pull requests from one shared counter, so the phase numbers and the issue numbers
do not line up — pull request #1 and issue #2 were created before this scheme
existed. The mapping is authoritative:

| Phase | Issue | Branch                          |
| ----- | ----- | ------------------------------- |
| 0     | #3    | `feature/0-infrastructure`      |
| 1     | #2    | `feature/1-delf-logic`          |
| 2     | #4    | `feature/2-db-schema`           |
| 3     | #5    | `feature/3-auth`                |
| 4     | #6    | `feature/4-gemini-session`      |
| 5     | #7    | `feature/5-audio-transport`     |
| 6     | #8    | `feature/6-audio-recording`     |
| 7     | #9    | `feature/7-evaluation`          |
| 8     | #10   | `feature/8-persistence`         |
| 9     | #11   | `feature/9-ui`                  |
| 10    | #12   | `feature/10-comparison-report`  |

Open pull requests with `Closes #N` so merging closes the issue. The description
follows [`.github/pull_request_template.md`](../.github/pull_request_template.md):
Summary, Changes, Test plan, Checklist, Definition of done. Write the Changes
section as one bullet per decision a reviewer has to agree with — not one bullet
per file — and record any deviation from the issue there rather than applying it
silently.

## Checks on every pull request

Six, in this order — the same six the company's DELF repository shows, verified
against the checks on its PR #429:

| # | Check                                        | Comes from                                 | Gate?                                       |
| - | -------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| 1 | `Build / Lint, typecheck, unit tests & build` | `.github/workflows/build.yml`              | **yes** — the one gate                      |
| 2 | `Claude Code Review / claude-review`          | `.github/workflows/claude-review.yml`      | advisory — a comment, not a pass/fail       |
| 3 | `Fallow / Codebase Intelligence`              | `.github/workflows/fallow.yml`             | report-only, by design                      |
| 4 | `GitGuardian Security Checks`                 | the GitGuardian GitHub App                 | yes, once installed                         |
| 5 | `Vercel`                                      | the Vercel GitHub integration              | reports the deployment                      |
| 6 | `Vercel Preview Comments`                     | the Vercel GitHub integration              | reports the preview comment                 |

Two details make the names come out right, and both are easy to break:

- A check's name is the **job's `name:`**, or its **job id** when un-named — not
  the `Workflow / Job` label the pull request page shows. `claude-review` has no
  `name:` on purpose, so it reads `Claude Code Review / claude-review`.
- GitHub lists checks alphabetically, so matching the names is what produces the
  matching order. There is nothing else to configure.

Lint, typecheck, unit tests and build are **one job**, not four. Four separate
jobs would each show as their own check and would not match the reference.
Any failing step fails the job, and the job is the gate.

Run the same gates locally before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build
```

`pnpm typecheck` is `next typegen && tsc --noEmit`, not bare `tsc`. Next 16
generates the route-aware global helpers (`PageProps`, `LayoutProps`,
`RouteContext`) into `.next/types` during `next dev` / `next build`, so a bare
`tsc --noEmit` passes on a warm working copy and fails on a cold CI checkout with
`TS2304: Cannot find name 'PageProps'`. `next typegen` produces them without a
full build — this is the documented way to typecheck in CI
(`node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`). It also
regenerates `next-env.d.ts`, which is untracked.

The build needs no secrets — every route is server-rendered on demand, so nothing
prerenders behind Clerk. Verified by building with `.env.local` removed. If a
future page does prerender behind auth, add placeholder env to the build job
rather than real keys.

## Codebase intelligence (Fallow)

`.github/workflows/fallow.yml`, ported from the DELF repository along with
`scripts/fallow-ci-summary.mjs`, runs [Fallow](https://docs.fallow.tools) on
every pull request: unused code and dependencies, duplication, complexity
hotspots, maintainability. It posts a Before/After table as a pull request
comment and writes a job summary.

**It never fails the build.** The step is `continue-on-error: true` — it exists
to surface a trend, not to block. To turn it into a gate later, save a baseline
(`fallow --baseline`) and fail on new issues only.

The version is pinned (`FALLOW_VERSION`) because unpinned `pnpm dlx fallow`
pulls latest and the scores drift between runs. Bump it deliberately.

Audits are taken against `develop`, this repository's trunk. To reproduce what
CI reports:

```bash
git fetch origin develop && pnpm dlx fallow@2.86.0 audit --base origin/develop
```

## Secret scanning (GitGuardian)

`GitGuardian Security Checks` comes from the **GitGuardian GitHub App**, not from
a workflow in this repository — the same way the DELF repository gets it. There
is no YAML to write; the app watches pushes and pull requests and reports its own
check.

**Installing it is a human step** and the only way this check can appear:

1. Sign in at [dashboard.gitguardian.com](https://dashboard.gitguardian.com) with GitHub.
2. Integrations → GitHub → install the app on `wafaezouiten/delf-oral-gemini`.
3. Enable the pull request check for the repository.

GitHub's own secret scanning and push protection are a separate thing and are
**not** available here: the repository is private on a Free plan, where they
require GitHub Advanced Security or a public repository. Enable them alongside
GitGuardian if either changes.

If the check fires: rotate the credential first — deleting the commit does not
un-leak it — then remove it from the history and re-push. Resolve or ignore the
incident in the GitGuardian dashboard, with a reason, rather than silencing the
check.

> This replaced a gitleaks workflow that ran in CI and was verified to fire on a
> planted key. GitGuardian was chosen for parity with the DELF repository.

## Claude review

`.github/workflows/claude-review.yml` reviews every non-draft pull request
for architecture, code quality, bugs, performance, security and test coverage.
`.github/workflows/claude.yml` responds to `@claude` in an issue, a comment or a
review.

Both need a repository secret `CLAUDE_CODE_OAUTH_TOKEN`. **This is the one piece
of setup that has to be done by a human**, since it is a credential:

```bash
claude setup-token
```

then add the value at **Settings → Secrets and variables → Actions → New
repository secret**, named `CLAUDE_CODE_OAUTH_TOKEN`.

Until it exists, both workflows emit a warning and skip, so pull requests are not
blocked by a red X for a token that has not been minted yet.

Two things about this check look like bugs and are not:

- **A run reads secrets when it starts.** Adding the secret does not retroactively
  fix a run that started before it existed — that run keeps printing
  `CLAUDE_CODE_OAUTH_TOKEN is not set` no matter how often you reload it. Push
  again, or `gh run rerun <id>`, and check the new run.
- **`claude-code-action` refuses to run until the workflow file is on the default
  branch.** It exchanges an OIDC token for an app token and validates that the
  workflow file is identical to the version on `develop`; on the pull request
  that *introduces* the workflow there is no such version, so it logs
  `Skipping action due to workflow validation` and exits successfully. The check
  is green and no review is posted. It starts reviewing on the first pull request
  opened after this workflow lands on `develop`. Note the same rule bites any
  pull request that *edits* `claude-review.yml`.

Reviews are posted by `claude[bot]`, a GitHub App identity obtained through that
OIDC exchange — which is why `pull-requests: read` is enough here, in both this
repository and the reference.

## Vercel preview deployments

The repository is linked to the Vercel project `delf-oral-gemini`
(`.vercel/project.json`). With the Vercel GitHub integration connected, every
pull request gets an automatic preview deployment and a preview URL, and Vercel
reports its status back onto the pull request. `vercel.json` pins that behaviour:

```jsonc
"github": { "enabled": true, "silent": false, "autoJobCancelation": true },
"git":    { "deploymentEnabled": true }
```

`silent: false` keeps the status comment on the pull request; `autoJobCancelation`
cancels superseded builds when you push again.

Preview builds need the environment variables from `.env.example` set in the
Vercel project (Preview scope): `GEMINI_API_KEY`, the Clerk pair, and
`DATABASE_URL`. Point previews at a branch database, not production.

To connect or verify the integration: Vercel → the project → **Settings → Git**.
This cannot be configured from the repository side.

## Branch protection

The rules are written as a runnable script, [`scripts/apply-branch-protection.sh`](../scripts/apply-branch-protection.sh),
because **they cannot be applied today**: the GitHub API rejects both classic
branch protection and rulesets on a private repository on the Free plan.

```console
$ gh api repos/wafaezouiten/delf-oral-gemini/branches/main/protection
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

Making the repository public or moving the account to GitHub Pro unblocks it;
then:

```bash
bash scripts/apply-branch-protection.sh
```

What the script applies:

| Branch    | Pull request required | Required checks                                                      | Extra                                           |
| --------- | --------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `develop` | yes                   | `Lint, typecheck, unit tests & build` + `GitGuardian Security Checks` | conversations resolved; no force push or delete |
| `staging` | yes                   | same                                                                 | branch must be up to date before merging        |
| `main`    | yes                   | same                                                                 | up to date, **and admins included** — nobody pushes directly |

Claude review and Fallow are deliberately not required: one is a comment, the
other is report-only. `GitGuardian Security Checks` only starts reporting once
the app is installed — requiring it before then leaves every pull request waiting
on a check that cannot arrive.

`required_approving_review_count` is 0: GitHub does not let you approve your own
pull request, so a non-zero count deadlocks a solo repository. Raise it to 1 for
`staging` and `main` as soon as there is a second reviewer.

## Status of this setup

- [x] Pull request template configured
- [x] `Build / Lint, typecheck, unit tests & build` — one workflow, one job, green
- [x] `Claude Code Review / claude-review` — secret added and read; the action self-skips until the workflow file is on `develop`, then reviews every pull request
- [x] `Fallow / Codebase Intelligence` — running, report-only
- [ ] `GitGuardian Security Checks` — **pending** the GitGuardian GitHub App install, which only a human can do; nothing in this repository can make this check appear
- [x] `Vercel` and `Vercel Preview Comments` — confirmed live on a pull request
- [ ] Branch protection rules — written and ready, **blocked** by the Free-plan private repository
