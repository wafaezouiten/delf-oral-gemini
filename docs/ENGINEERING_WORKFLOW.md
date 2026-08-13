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

| Check                | Workflow                                | Gate?                                     |
| -------------------- | --------------------------------------- | ----------------------------------------- |
| Lint                 | `.github/workflows/ci.yml`              | yes                                       |
| Typecheck            | `.github/workflows/ci.yml`              | yes                                       |
| Unit tests           | `.github/workflows/ci.yml`              | yes                                       |
| Build                | `.github/workflows/ci.yml`              | yes                                       |
| Secret scan          | `.github/workflows/secret-scan.yml`     | yes                                       |
| Claude review        | `.github/workflows/claude-code-review.yml` | advisory — a comment, not a pass/fail  |
| Vercel preview       | Vercel Git integration                  | reports its own status on the pull request |

The four CI checks are separate jobs rather than four steps of one job, so each
reports as its own status check and can be named individually in the branch
protection rules. Any failing job fails the workflow.

Run the same gates locally before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build
```

The build needs no secrets — every route is server-rendered on demand, so nothing
prerenders behind Clerk. Verified by building with `.env.local` removed. If a
future page does prerender behind auth, add placeholder env to the build job
rather than real keys.

## Secret scanning

`.github/workflows/secret-scan.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
(pinned version, binary fetched from the release page rather than a third-party
action) against both the working tree and the commits the pull request adds — a
secret that was committed and then deleted still leaked.

GitHub's own secret scanning and push protection are **not** available here: the
repository is private on a Free plan, where they require GitHub Advanced Security
or a public repository. Enable them alongside gitleaks if either changes.

If the scan fires: rotate the credential first — deleting the commit does not
un-leak it — then remove it from the history and re-push. For a genuine false
positive, add a narrow allowlist entry to `.gitleaks.toml` with a comment saying
why it is not a credential.

## Claude review

`.github/workflows/claude-code-review.yml` reviews every non-draft pull request
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

| Branch    | Pull request required | Required checks                                   | Extra                                           |
| --------- | --------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `develop` | yes                   | Lint, Typecheck, Unit tests, Build, Secret scan   | conversations resolved; no force push or delete |
| `staging` | yes                   | same                                              | branch must be up to date before merging        |
| `main`    | yes                   | same                                              | up to date, **and admins included** — nobody pushes directly |

`required_approving_review_count` is 0: GitHub does not let you approve your own
pull request, so a non-zero count deadlocks a solo repository. Raise it to 1 for
`staging` and `main` as soon as there is a second reviewer.

## Status of this setup

- [x] Pull request template configured
- [x] CI workflow configured — lint, typecheck, unit tests, build
- [x] Claude review workflows configured — **pending** the `CLAUDE_CODE_OAUTH_TOKEN` secret, which only a human can mint
- [x] Secret scanning configured (gitleaks in CI; GitHub's own scanner needs a public repo or a paid plan)
- [x] Vercel preview deployments pinned in `vercel.json` — **pending** confirmation that the Vercel Git integration is connected, which is done in the Vercel dashboard
- [ ] Branch protection rules — written and ready, **blocked** by the Free-plan private repository
