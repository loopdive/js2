---
id: 4670
title: "ES5 standalone: element PRESENCE, not value — __hasOwnProperty has no dense-element arm, #4638's absent-concat marker survives `===` but not a boxing boundary, and the grow-gap marker breaks under a different receiver spelling"
status: ready
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array
goal: standalone-gap
related: [4655, 4638, 4667, 3580]
origin: "residuals R-P, R-H and R-B of the #4655 concat lane, plus a live defect it found while making its pins unfoldable. All measured on BOTH arms by that lane; R-P and the grow-gap defect are PRE-EXISTING (identical on base), not introduced."
---

## One theme: after #4655's concat fix, the remaining rows fail on PRESENCE, not value

The #4655 concat lane fixed the value half — `concat/S15.4.4.4_A1_T2` flips, and
`A3_T{1,2,3}` move from a wrong **value** to a wrong **presence** (they now fail at
`hasOwnProperty`). That movement is what makes these three residuals one issue: the
elements are now *correct*, and what is wrong is whether the array reports them as
*there*.

## R-P — `__hasOwnProperty` has no dense-element arm

Answers `false` for **every** index of a dynamic array carrier. Measured **identically on
both arms**, so pre-existing, not introduced by the concat fix.

Declined by the concat lane on blast radius, and that judgement stands: `hasOwnProperty`
is what test262's `propertyHelper.js` is built on, so changing it moves the harness under
a large fraction of the corpus at once. Read
`plan/issues/4667-arguments-array-identity-vec-shared-rep.md` before starting — it
documents the adjacent case where narrowing an Array-identity predicate silently trades
`10.6-6-2` away, and the same class of coupling applies here.

**This is the row-bearing half.** It is what `A3_T{1,2,3}` now fail on.

## R-B — #4638's absent-concat marker survives `===` but not a boxing boundary

New root, found by a pin the lane wrote as a *control* which then went red. This is the
root of `A3_T{2,3}`'s **base** failure.

The marker that represents an absent concat element compares equal under `===` but does
not survive being boxed. Start from where the boxing boundary is crossed, not from the
comparison.

## R-H — an all-elisions literal `[,]` as an operand · ROOT NOT ISOLATED

The lane measured the axis (whether the elision has a non-hole sibling) and **explicitly
did not claim a root**, because the obvious story is contradicted by its own control:
`Array.prototype.indexOf.call([,], undefined)` answers `0` on **both** arms.

Do not adopt the obvious explanation without re-deriving it. An honest "not isolated" is
recorded here deliberately so the next lane starts from the contradiction rather than
from a guess.

## Also found, and separate: the grow-gap marker breaks under a different receiver spelling

While making pins unfoldable, the lane rewrote a receiver as
`var a = []; a[0] = 0; a.length = 3` instead of the corpus's `var a = [0]; a.length = 3`,
and **the direct read broke** — `a[2]` misses `Array.prototype[2]` and `a[1]` reads `0`.
Five pins moved onto a different carrier.

That is a **live defect in the grow-gap marker**, independent of concat, and it is not a
pin-authoring artifact: the two spellings should produce the same observable array. Worth
a separate slice; recorded here so it is not rediscovered as a pin problem.

## Implementation Plan

1. `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully. Note in particular
   the new sections on byte identity replacing the base arm, `includes:` splicing harness
   code into your compilation unit, and unfoldable pins landing on a different carrier —
   all three came out of the lane that filed these residuals.
2. **Take R-B first.** It is the narrowest, it has a named root, and it is what makes two
   of the `A3` rows fail on base. It may not need R-P at all.
3. **R-P second, and only with a `propertyHelper` canary on both arms.** The gate is not
   "does `hasOwnProperty` answer correctly" but "does the harness still answer the same
   for rows that pass today". Quote `10.6-6-2` and the `A3_T{1,2,3}` rows by name.
4. **R-H last, or decline it again with the measurement.** Re-deriving the contradiction
   is worth more than a speculative fix.
5. The grow-gap marker defect is a separate slice — file it or take it deliberately, but
   do not fold it in silently.

## Acceptance

- `A3_T{1,2,3}` reach a correct presence answer, or the reason they cannot is measured.
- **No row that passes today regresses** — `10.6-6-2` and the `propertyHelper`-dependent
  rows are the canary, run on both arms.
- Zero-regression argument via `wasm_sha` byte identity where the diff is gated, per the
  brief; the base arm executed only for modules whose bytes differ.
- Anything declined is declined with a measurement and a named contradiction, not a guess.
