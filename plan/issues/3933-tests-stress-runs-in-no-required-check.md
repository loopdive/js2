---
id: 3933
title: "tests/stress/ runs in no required check — the npm-package milestone probes are ungated and look gated"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: easy
reasoning_effort: medium
task_type: ci
area: ci, test-infrastructure
goal: npm-library-support
sprint: current
horizon: s
es_edition: n/a
related: [1282, 1400, 3008, 3672, 3687]
---

# #3933 — `tests/stress/` is in no required check

## What you will see (the observable)

A PR goes **fully green** while an ESLint / Hono / React / lodash Tier-N stress
probe is broken on that same PR. Nothing reports it. The files sit under
`tests/`, look like ordinary vitest suites, and are cited in issue acceptance
criteria as though they gate — so a reader concludes the milestone is protected
when it is not.

This is not hypothetical. **PR #3687 recorded, in its own description, that
after merging `main` the full ESLint graph no longer compiled — and it was
still able to go green.** The only reason that regression was visible at all is
that the PR author wrote it down by hand.

## Verified against `origin/main` @ `e4187572` (2026-07-31)

| Gate                                     | What it actually runs                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `equivalence-gate` / `equivalence-shard` | `tests/equivalence/` only                                                      |
| `linear-tests`                           | `tests/linear-*`, `c-abi`, `simd*`                                             |
| #3008 "changed root test files must pass" | **root-only** — `^tests/[^/]+\.test\.ts$`, so `tests/stress/…` never matches   |
| any workflow                              | `grep -rn "tests/stress" .github/workflows/` → **no matches**                  |

Files affected: `tests/stress/eslint-tier1.test.ts`,
`hono-tier1..6.test.ts`, `lodash-tier2.test.ts`, `react-tier1.test.ts`.

Note the interaction with the #3008 design: the post-merge half
(`issue-tests.yml`) **detects but does not enforce**, and its own selector is
the same root-only pattern. So `tests/stress/` is not merely unenforced — it is
largely unobserved.

## The decision to make (either outcome is acceptable; the current state is not)

This issue is closed by making the truth **explicit**, not necessarily by
adding a gate.

**Option A — wire a post-merge job.** The ESLint Tier-1 probe is ~10 min
(#3672's `tests/helpers/eslint-graph-probe.ts` already enforces a heap + wall
budget and fails as a *named probe failure* rather than "no diagnostics"), so
per-PR is likely too expensive but post-merge is not. Post-merge detection at
least surfaces a regression within one merge instead of never.

**Option B — record that they are manual milestone probes.** Add an explicit
header to each `tests/stress/*.test.ts` and to the issues that cite them saying
they are **not gated**, so nobody reads a green PR as evidence about them.

Option A for at least the ESLint probe is preferred, since that is the one with
an active milestone (#1400) resting on it. But a documented, honest "not gated"
is strictly better than the current state, where the same file looks gated to
every reader.

## Do not do

- Do **not** widen the #3008 root-only selector to `tests/**` wholesale. That
  pulls the entire ~2,100-file suite (~9 CPU-hours, per the #3552 note in
  `ci.yml`) into per-PR, which is exactly the cost the two-layer design exists
  to avoid.
- Do **not** add a gate whose green is vacuous when the fixture is absent. The
  ESLint probes `skipIf(ESLINT_LINTER === null)`; a CI job that skips-to-green
  when the devDependency is missing reproduces the #3653 vacuity class one
  level up. If it is wired, assert that the probe **ran**.

## Acceptance criteria

1. Either a post-merge (or explicitly-scoped per-PR) job runs at least
   `tests/stress/eslint-tier1.test.ts` and reports its result, **or** every
   `tests/stress/*.test.ts` carries a header stating it is not covered by any
   required check.
2. If a job is added: a **kill-switch demonstration** — deliberately break the
   probe on a scratch branch and show the job goes red. A gate never seen to
   fail is indistinguishable from one that does not run.
3. If a job is added: it fails, not skips, when the ESLint devDependency is
   present but the probe did not execute.
4. `docs/ci-policy.md` §7 reflects whichever choice was made.
