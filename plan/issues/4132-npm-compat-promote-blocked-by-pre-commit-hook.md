---
id: 4132
title: "npm-compat promotion fails: the bot's `git commit` runs husky's pre-commit hook, which cannot resolve a merge base under `fetch-depth: 1` — the artifact still never lands"
status: done
sprint: 78
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: tooling, ci
language_feature: none
goal: dogfood
related: [4130, 3988, 4127]
origin: "the #4130 fix landed, the gate stopped deferring, and the promote step failed instead — 2026-08-03"
---

# #4132 — the promotion commit is blocked by the pre-commit hook

## How this surfaced

#4130 fixed the staleness floor so the queue gate stops deferring on every run.
It worked: the promote step now **executes**. It then **fails**.

Every `npm-compat-refresh` run after #4130 landed (06:49) has failed — 06:49,
08:23, 09:56, 11:32 — and the artifact is still the manual 2026-08-01 snapshot.

This is a second, independent bug that #4130 unmasked. It has presumably been
there since the workflow was written; the promote step had simply never run.

## Root cause

```
> @loopdive/js2@0.67.0 test:changed-root
> sh scripts/hooks/changed-root-tests.sh

changed-root-tests: cannot resolve a merge base with origin/main.
Fetch origin/main or set CHANGED_ROOT_TESTS_BASE to a local base ref.
 ELIFECYCLE  Command failed with exit code 1.
```

`.husky/pre-commit` runs `pnpm run test:changed-root`, which needs a merge base
with `origin/main`. In this job there is none:

- the checkout is `fetch-depth: 1` with `persist-credentials: false`;
- the push remote is added as `deploykey`, not `origin`.

So the hook aborts the commit and the step exits 1.

## Why the sibling bot is unaffected

`benchmark-refresh.yml` issues the same hook-free `git commit` and works — but
only **structurally**. Its `promote-benchmarks` job is separate and does
checkout + `download-artifact` only; it never runs `pnpm install`, so husky's
hooks are never installed.

`npm-compat-refresh.yml` is deliberately a SINGLE job (its own comment explains
why: it never runs on PRs, so there is no untrusted-code split to make), which
means it installs dependencies and then commits in the same job. It therefore
has to opt out of the hook explicitly.

## Fix

`git commit --no-verify` in the promote step. Running the changed-root test
suite over generated JSON artifacts would be meaningless even if it could
resolve a base.

## Permanent repro

`tests/issue-4130-npm-compat-refresh-staleness-gate.test.ts` — the guard lives
alongside #4130's rather than in a file of its own, because the two failures are
the same mechanism observed one step apart (the gate stops deferring, so the
promote step finally runs, and then fails). Splitting them would let one be
edited without the other being re-read. The `#4132` describe block asserts
`--no-verify` on the promote commit and that `[skip ci]` survives.

## Acceptance criteria

- [x] The promote step commits without invoking the pre-commit hook.
- [x] A structural regression test asserting `--no-verify` on the promote
      commit, and that the `[skip ci]` marker survives (it is what breaks the
      trigger loop) — `tests/issue-4130-npm-compat-refresh-staleness-gate.test.ts`.
- [x] The test is demonstrated to FAIL against the unfixed workflow.

## Not yet verified

**The end-to-end promotion has NOT been observed.** #4130 was also believed
fixed until its next run revealed this. The only proof that matters is the
artifact's commit history moving off `3ffd8ed5c` (2026-08-01), and that cannot
be confirmed until a run completes after this lands. If a THIRD blocker sits
behind this one, the same investigation applies: read the failing step, do not
assume the previous fix was sufficient.
