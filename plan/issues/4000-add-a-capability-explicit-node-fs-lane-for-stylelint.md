---
id: 4000
title: "npm-compat: add a capability-explicit Node fs lane for Stylelint"
status: done
sprint: 78
created: 2026-07-30
updated: 2026-08-18
completed: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
language_feature: n/a
goal: dogfood
related: [1491, 3587, 3995, 4302, 4303]
---

# npm-compat: add a capability-explicit Node fs lane for Stylelint

## Problem

Stylelint 17.14.1 lib/index.mjs is currently refused because Node fs capability is intentionally disabled.

Add a labeled opt-in Node fs compatibility lane and report it separately on npm-compat. Do not silently grant filesystem access in the default sandboxed lane.

Reproduce: pnpm run dogfood:stylelint.

## Resolution

The catalog now carries per-package compile options and opts only Stylelint into
`allowFs: true`. Package-entry reports expose the granted capability and the npm
compat card labels it `fs enabled`; every other catalog entry keeps the default
filesystem-denied compiler policy.

This removes the intentional capability refusal and exposes Stylelint's real
compiler frontiers (#4302 async `await` inside `try` and #4303 module-TDZ
planning). It does not claim that Stylelint already compiles or runs.

## Measured result and handoff

The unchanged catalog harness completed in **82.319 seconds** with
`allowFs: true`, proving that it advanced past the old `readFileSync` refusal.
It emitted no binary and reported six compiler diagnostics: five residual
`await`-inside-`try` shapes owned by #4302 and one
`module TDZ global noop was observed before its value global` owned by #4303.
The capability lane is complete; compilation work resumes in those two issues.

## Acceptance criteria

- [x] Stylelint's catalog compile receives `allowFs: true`.
- [x] No other package receives filesystem access implicitly.
- [x] The report and card disclose the filesystem capability.
- [x] The bounded Stylelint harness advances past the `readFileSync` refusal.

Permanent coverage: `tests/dogfood/npm-compat-catalog.test.ts` verifies that
Stylelint alone receives the explicit filesystem capability.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
