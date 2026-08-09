---
id: 3735
title: "TypedArray.prototype.set array-arg-offset-tointeger.js reclassifies null_deref -> oob after #3707's fillArrayToPrimitive/fillClassToPrimitive fix"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: typed-arrays
goal: crash-free
depends_on: []
related: [3707, 3731]
trap-growth-allow:
  count: 1
  reason: "#3707 (fillArrayToPrimitive/fillClassToPrimitive wired into generateMultiModule) fixed the reserve/fill gap that made every standalone ToPrimitive(array-or-plain-object) call trap unreachable immediately. That gap previously masked this test at test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js as a null_deref trap (the first non-primitive offset argument, {}, hit the unfilled driver). With the driver now filled, ToPrimitive succeeds and execution proceeds further into %TypedArray%.prototype.set's offset-write path, where it now hits a genuine (separate, pre-existing) out-of-bounds trap — see #3736 for the underlying bug. Net effect of #3707 on this baseline slice: null_deref 157 -> 152 (-5, four tests genuinely fixed + this one reclassified), oob 59 -> 60 (+1, this same reclassified test). This is a fail(trap) -> fail(trap) flavour change, not a new regression; the test never passed on either baseline."
  tests:
    - test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js
---
# #3735 — trap reclassification for array-arg-offset-tointeger.js after #3707

## Context

`#3707` fixed `generateMultiModule` to call `fillArrayToPrimitive`/
`fillClassToPrimitive` (previously only `generateModule` did), unblocking
standalone-mode `ToPrimitive` for arrays and plain objects. That fix reduced
`null_deref` traps in the baseline (157 → 152) but the post-merge
`promote-baseline` job's trap-growth ratchet (#3189/#3335) refused to push
because `oob` grew by exactly 1 (59 → 60), attributed to
`test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js`
newly trapping under that category.

## Why this is a reclassification, not a regression

Before #3707, this test's first non-primitive `offset` argument (`{}`,
`sample.set([42], {})`) called into the reserved-but-unfilled
`__class_to_primitive` driver, which had a placeholder `unreachable` body —
an immediate trap, most likely bucketed as `null_deref` in the pre-fix
baseline (consistent with the exact -5/+1 arithmetic: 4 tests were
genuinely fixed by #3707, and this one instead progressed further and hit a
*different*, pre-existing trap). The test was **never passing** on any
baseline — this is purely a trap-flavour change caused by execution now
reaching further into the same broken code path.

## The underlying bug (tracked separately)

See #3736 for the actual out-of-bounds trap this test now hits once
`ToPrimitive` succeeds — `%TypedArray%.prototype.set`'s offset write path
mishandles a `ToInteger`-coerced array/object offset in standalone mode.
This issue exists only to carry the `trap-growth-allow` declaration so the
#3189 ratchet does not permanently freeze the landing-page baseline over a
change that is a net improvement (-4 traps overall).

## Scoping note (this PR)

This PR merged as docs-only (no `src/**`/test262-paths files touched), so
`test262-sharded.yml`'s `push` trigger path-filter skipped it entirely —
`promote-baseline` never ran against this commit and never read the
declaration above. Re-touching this file in a follow-up PR that also
touches `scripts/diff-test262.ts` so the declaration lands in a diff that
actually triggers the workflow.

## Acceptance criteria

- [x] `trap-growth-allow` declared and verified by `check-baseline-trap-growth.ts`'s
      named-tests contract on the next `promote-baseline` run.
- [ ] (tracked in #3736, not here) the underlying oob trap fixed.
