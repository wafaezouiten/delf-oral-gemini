<!--
  Structure mirrors the company's DELF repository (delf-preps), PR #429.
  Delete any section that genuinely does not apply — do not delete all of them.
-->

Closes #

## Summary

<!-- One paragraph: what this PR does and why, in prose. Reviewers read this first. -->

## Changes

<!--
  The substance. One bullet per decision a reviewer has to agree with, not one
  bullet per file. Call out anything that changes behaviour, and name the
  trade-offs you made rather than leaving them to be discovered in the diff.
-->

-

## Test plan

<!--
  What you actually ran, with results — not what someone could run.
  Tick what passed; leave unticked what is still outstanding and say so.
-->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm build`
- [ ] Manual verification (describe what you exercised, and against what)

## Checklist

- [ ] Branch cut from `develop` and targets `develop` (or is a documented `develop` → `staging` / `staging` → `main` promotion)
- [ ] Linked to its issue with `Closes #N`
- [ ] Scope matches the issue — no unrelated changes ride along
- [ ] No secrets, API keys, tokens or `.env` values in the diff
- [ ] New behaviour is covered by unit tests
- [ ] Docs / `.env.example` updated if the change needs them
- [ ] Deviations from the issue as written are documented in **Changes**, not silently applied

## Definition of done

- [ ] All CI checks green (lint, typecheck, unit tests, build)
- [ ] Secret scan clean
- [ ] Claude review addressed — every comment either fixed or answered
- [ ] Vercel preview deployment builds and the change is verified on it
- [ ] The issue's own definition of done is fully ticked
