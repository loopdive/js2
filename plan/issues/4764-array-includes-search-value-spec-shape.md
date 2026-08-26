---
id: 4764
title: "Array.prototype.includes: zero-arg form and non-numeric search values (ES2016 conformance)"
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
sprint: current
horizon: s
loc-budget-allow:
  # 2026-08-26 — +4 lines in src/compiler.ts for `diagnosticSeverity`, a helper
  # that replaces the SAME three-way downgrade expression duplicated across the
  # three diagnostic-collection loops (single-source, multi-file entry,
  # multi-file full). Adding the new predicate inline would have grown all three
  # sites and let them drift apart; the helper is the smaller and safer shape.
  # The predicate itself lives in the subsystem module
  # (src/compiler/argument-diagnostics.ts), not the driver.
  - src/compiler.ts
---

# #4764 — `Array.prototype.includes`: zero-arg form and non-numeric search values

Residual of #1360, found while closing the ES2016 bucket (124 tests).

## Problem

Two distinct defects, both in how the `searchElement` operand reaches codegen.

**1. The zero-argument form was rejected outright.** §23.1.3.16 takes
`searchElement` as an ordinary parameter, so `arr.includes()` is legal and
searches for `undefined`. The compiler raised "includes requires 1 argument",
which made the whole call compile to nothing and evaluate as `undefined`:

```
built-ins/Array/prototype/includes/no-arg.js
  [0].includes() Expected SameValue(«undefined», «false») to be true
built-ins/Array/prototype/includes/length-zero-returns-false.js
  returns false - no arg Expected SameValue(«undefined», «false»)
```

**2. A non-numeric search value was COERCED into the element type.** TypeScript's
lib types the parameter as the element type `T` — stricter than the language,
which accepts any value and answers `false`. So `[42, 0, 1, NaN].includes("42")`
is six TS2345s, and `isHardTypeScriptDiagnostic` aborts before codegen: the
program compiles to zero bytes.

The misleading part: `includes/samevaluezero.js` carries the baseline error
string `'42' Expected SameValue(«true», «false»)`, which reads like a
wrong-answer row. Reproduced faithfully it is a **compile_error** row. Bucketing
from baseline strings alone sent two earlier attempts after the wrong bug —
hence `scripts/run-test262-row.mts`, which reproduces one row through the
runner's own `wrapTest` and reports the runner's own verdict.

## Fix

`src/codegen/array-includes-search-value.ts` (leaf module — `array-methods.ts`
is at its god-file cap) owns the operand:

- **absent argument** → emit whatever an explicit `undefined` would produce for
  this element type, so the two spellings cannot disagree: a real `undefined` in
  an `externref` vec, `f64` NaN in a numeric vec (a hole reads as NaN there, and
  the both-NaN arm of the comparison is what makes `[, , , 42, , ].includes()`
  answer `true`). Any other element type forces the scan comparison to a
  constant `0`; leaving `valTmp` at its zero default would compare against `0`
  and make `[0].includes()` wrongly answer `true`.
- **argument whose static `typeof` tag cannot be a number**, against an
  `i32`/`f64` element vec → evaluate it for side effects, drop it, and force the
  comparison to `0`. §7.2.12 compares `Type(x)` before value, so no such value
  can ever match. The tag comes from `ctx.oracle.staticJsTypeOf`, never the raw
  checker.

`src/compiler/argument-diagnostics.ts` gains `isArraySearchElementDiagnostic`:
a TS2345 on the first argument of `includes` / `indexOf` / `lastIndexOf` is not
a hard error. It both exempts the diagnostic from the `failResult` gate and
downgrades it to a warning — **both are required**, because the test262 runner
counts any error-severity diagnostic as `compile_error` even when a binary came
out. Mirrors the #2616 Proxy-handler-trap and #2741 `in`-operand downgrades.

The downgrade alone would have been a bug rather than a fix: without the codegen
half, `"42"` coerces to f64 `42` and `samevaluezero.js` flips from
compile_error to a genuine wrong answer.

## Acceptance criteria

Measured by running the ES2016 feature set (147 files tagged
`Array.prototype.includes` / `exponentiation` / `u180e`) through the runner's own
`runTest262File`: **103 → 104 pass, no regressions.**

- [x] `built-ins/Array/prototype/includes/no-arg.js` passes
- [x] `built-ins/Array/prototype/includes/samevaluezero.js` passes
- [x] `built-ins/Array/prototype/includes/search-not-found-returns-false.js` passes
- [x] `built-ins/Array/prototype/includes/sparse.js` still passes — it briefly
      did NOT (see below)
- [x] `tests/equivalence/array-includes-no-arg.test.ts` — 10 cases, incl. the
      coercion traps (`"42"`, `true`/`false`, `null`), argument side effects, and
      the sparse-hole guard

`length-zero-returns-false.js` does **not** pass. Its no-arg assertion is fixed,
but a later assertion in the same file ("length is checked before
ToInteger(fromIndex)") exercises the array-like `.call` path and still fails —
it belongs to the bucket below, not here. An earlier draft of this issue and its
commit message claimed the row passed; that came from judging the row by whether
it compiled rather than by running it, which is precisely the mistake
`run-test262-row.mts` now guards against (its verdict was corrected to mirror the
runner: an error-severity diagnostic is a compile_error even when a binary came
out).

## A regression this change introduced, and the fix

The first cut listed `"undefined"` in `NEVER_A_NUMBER`, forcing
`includes(undefined)` false against a numeric vec. That flipped
`built-ins/Array/prototype/includes/sparse.js` from **pass to fail**: per
§23.1.3.16 step 7a holes are read with `Get`, which returns `undefined`, so
`[, , , 42, , ].includes(undefined)` is `true`. In an f64 vec a hole reads as NaN
and `undefined` coerces to NaN, so the pre-existing both-NaN arm of the
SameValueZero comparison was already producing the right answer — and the new
predicate overrode it.

Caught only by running the edition set before and after against `origin/main`,
not by the targeted rows. The encoding stays imprecise in the other direction
(`[NaN].includes(undefined)` wrongly answers `true`); that is pre-existing and
out of scope here.

## Known limitations

- **`as any` erases the tag.** The refusal is driven by the argument's STATIC
  tag, so `[42].includes("42" as any)` is `"mixed"` and still takes the coercing
  path — it answers `true`. Closing that needs a tagged runtime comparison, not
  a static one. No test262 row depends on it (the annotation is TypeScript-only
  syntax that never appears in conformance tests); recorded in the test file.
- **`.call` forms are untouched.** `Array.prototype.includes.call(obj, "a")`
  raises its TS2345 on `.call`'s argument, not on an `includes(...)` argument,
  so the syntactic predicate does not match. Those rows
  (`includes/length-boundaries.js` and the rest of the 2^53-length family) stay
  in the separate array-like bucket.
