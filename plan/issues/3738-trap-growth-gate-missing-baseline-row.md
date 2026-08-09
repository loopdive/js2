---
id: 3738
title: "check-baseline-trap-growth.ts never passed missingBaselineRowsAreUnknown, so a test absent from the prior snapshot reads as fabricated trap growth"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: ci-infra
language_feature: n/a
goal: crash-free
depends_on: []
related: [3707, 3735, 3736]
---
# #3738 — promote-baseline's trap-growth gate treats a missing baseline row as growth

## Context

Discovered while landing #3735's `trap-growth-allow` declaration for the
#3707 `null_deref`→`oob` reclassification (see #3735/#3736). After fixing
the declaration's change-scoping (#3710), the `promote-baseline` job's
trap-growth gate found the declaration but refused it for a different
reason:

```
trap-growth-allow (#3596): declared test "test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js"
has NO baseline row, so the reclassification claim cannot be verified
```

Confirmed by freshly re-fetching `loopdive/js2wasm-baselines`'
`test262-current.jsonl` directly: this exact file genuinely has zero rows
in it. The `#3735` narrative (previously `null_deref`, now `oob`) is
therefore unverifiable — it may be true or the test may simply be new to
whatever snapshot this baseline artifact captured; the data doesn't say.

## Root cause

`scripts/diff-test262.ts`'s `evaluateTrapCategoryGrowth` already has a
`missingBaselineRowsAreUnknown` option (doc comment: "Enable this for
baseline artifacts that are expected to cover the same Test262 corpus:
there an absent row is an incomplete observation, not evidence of a new
test") — exactly this scenario, since `check-baseline-trap-growth.ts`
compares before/after snapshots of the SAME full-corpus root baseline
built fresh on every promote run.

The option is already exercised by `tests/issue-3592-devacuification-allow.test.ts`
and `tests/issue-3596-trap-growth-allow-nonrebase.test.ts` (both pass
`missingBaselineRowsAreUnknown: true`), but `check-baseline-trap-growth.ts`'s
own CLI call at the bottom of `main()` never passed it — the only real
call site in the whole codebase, so the option was fully designed and
tested but never wired up.

## Fix

Pass `{ missingBaselineRowsAreUnknown: true }` at the `evaluateTrapCategoryGrowth`
call site in `scripts/check-baseline-trap-growth.ts`.

## Verification

- Existing tests (`issue-3189`, `issue-3457`, `issue-3592-devacuification-allow`,
  `issue-3596-trap-growth-allow-nonrebase`) all pass unchanged (53 tests) —
  the option itself is already correctness-tested, this just wires it in.
- New test in this PR pins the specific CLI-level bug: a candidate-only row
  no longer counts as growth.
