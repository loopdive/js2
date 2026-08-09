---
id: 4306
title: "A `boolean[]` passed as a function PARAMETER reads back `undefined` (string[] / any[] are fine)"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: medium
horizon: s
feasibility: medium
model: opus
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays
goal: core-semantics
related: [4238]
# id allocated after fast-forwarding the fork's main to upstream — see the
# note in #4305 about claim-issue.mjs resolving "main" against the FORK and
# minting already-used ids from a stale fork. Open-PR scan DEGRADED (no gh)
# and code search 503 at authoring time; the required check:issue-ids gate is
# the backstop.
---

# #4306 — `boolean[]` parameter reads back `undefined`

## Discovered by

#4238 slice 3, incidentally, while threading typed arrays through the
direct-eval scope-snapshot plumbing. Not eval-specific — eval was only the
context in which it surfaced.

## The defect

A `boolean[]` value passed as a **function parameter** reads back `undefined`
at the callee. The same shape works when the array is a local or a module-level
binding, and `string[]` / `any[]` parameters are unaffected — so it is specific
to the boolean element type crossing the parameter boundary.

## Why it matters

Silent wrong-value (not a trap, not a throw): the callee sees `undefined` where
a real array was passed, so it corrupts results rather than failing loudly.
That is the worst failure mode to leave latent, and the narrowness of the
trigger (boolean elements, parameter position only) is exactly what makes it
survive casual testing.

## Repro

Recorded in the `## Slice 3 — implementation record` section of
`plan/issues/4238-quickjs-runtime-eval-provider-flag.md`.

## Acceptance criteria

- [ ] Minimal repro as a permanent test failing on current main.
- [ ] Root cause named in `src/codegen/` — why the boolean element type's
      parameter lowering diverges from `string[]`/`any[]`.
- [ ] Fix covers parameter position for boolean arrays; local/module positions
      stay working; add coverage for all three positions × the element types
      that share the lowering path.
- [ ] Equivalence suite green; no test262 regressions.
