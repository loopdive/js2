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

- **absent argument** → emit `undefined` when the element vec is `externref`
  (where SameValueZero can genuinely match a hole read as `undefined`);
  otherwise force the scan comparison to a constant `0`. Leaving `valTmp` at its
  zero default would compare against f64 `0` and make `[0].includes()` wrongly
  answer `true`.
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

- [x] `built-ins/Array/prototype/includes/no-arg.js` passes
- [x] `built-ins/Array/prototype/includes/samevaluezero.js` passes
- [x] `built-ins/Array/prototype/includes/search-not-found-returns-false.js` passes
- [x] `tests/equivalence/array-includes-no-arg.test.ts` — 9 cases, incl. the
      coercion traps (`"42"`, `true`/`false`, `null`) and argument side effects

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
