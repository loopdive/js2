---
id: 1440
title: "spec gap: Date setters ToNumber coercion + Invalid Date (NaN) propagation"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: date
goal: spec-completeness
sprint: 52
related: [1343, 1344, 1434]
---
# #1440 - Date setters ToNumber coercion + Invalid Date propagation

## Problem

`Date.prototype.set*` methods (setHours, setMinutes, setSeconds,
setMilliseconds, setDate, setMonth, setFullYear, setYear, setTime, and
UTC variants) fail when the argument is anything other than a directly-
typed `number`. Per §21.4.4 each setter coerces every argument with
`ToNumber`, which must:

- Call `valueOf` on objects (then `toString` if `valueOf` returns non-primitive)
- Invoke `Symbol.toPrimitive("number")` if present
- Convert `null → 0`, `true → 1`, `false → 0`, `undefined → NaN`
- Parse strings like `'   +00200.000E-0002\t'` to a number
- Throw `TypeError` when `Symbol` is supplied

Additionally, if any coerced argument is `NaN`, the result must set the
Date's `[[DateValue]]` to `NaN` (Invalid Date sentinel) and return `NaN`.

Sample failing tests:
- `test/built-ins/Date/prototype/setHours/arg-min-to-number.js` —
  object with `valueOf`, null/true/false/string/undefined args.
- `test/built-ins/Date/prototype/setHours/arg-min-to-number-err.js` —
  `valueOf` throws → must propagate.
- `test/built-ins/Date/prototype/setFullYear/this-value-invalid-date.js`
  — Invalid Date + valid arg should re-validate via spec algorithm.
- `test/built-ins/Date/prototype/setMonth/arg-month-to-number-err.js`
  — abrupt completion from arg `ToNumber`.
- `test/built-ins/Date/prototype/setMilliseconds/date-value-read-before-tonumber-when-date-is-valid.js`
  — observable ordering: read `this` `[[DateValue]]` *before* `ToNumber`.

## Failure count

89 failures across `built-ins/Date/prototype/set*` (and a few related
getter/conversion tests) in test262-current.jsonl, including:
- `setFullYear`: 14, `setMonth`: 11, `setYear`: 10, `setHours`: 8,
  `setDate`: 8, `setMinutes`: 7, `setSeconds`: 6, `setMilliseconds`: 5,
  `setUTCMonth`: 5, plus UTC variants.

## Root cause

`src/codegen/expressions/builtins.ts` ~580-720 implements the time-of-day
setters by calling `compileExpression(ctx, fctx, args[argIdx]!, { kind: "f64" })`
and then `i64.trunc_sat_f64_s`. This direct-to-f64 coercion only works when
the static TS type is `number`. For externref/any arguments the compiler
does **not** invoke a runtime `ToNumber` helper, so:

- An object with `valueOf` is treated as NaN (not coerced).
- A boolean/null/string is not coerced to a number.
- `i64.trunc_sat_f64_s` *saturates* NaN to 0 instead of marking the Date
  as Invalid — explicit comment at line ~601 acknowledges this.

The date-setter path also never reads `[[DateValue]]` *before* coercing
the arg (observable via the `valueOf` callback ordering test).

## Implementation sketch

1. Route every set*/UTC* setter arg through the existing `ToNumber`
   runtime helper (the same one used by #1434 for unary `+`) instead of a
   direct `compileExpression(..., { kind: "f64" })`. This handles
   valueOf/toString/Symbol.toPrimitive/null/bool/string/Symbol-throw.
2. Add a NaN-bypass: if any coerced arg is NaN (or current `[[DateValue]]`
   is the Invalid-Date sentinel and the setter touches a "year"
   component), write the Invalid-Date sentinel into the struct and return
   `NaN`. This is the Slice-1 NaN propagation called out in the existing
   inline comment.
3. Hoist the `[[DateValue]]` read out of the setter to occur *before* any
   user code in the arg list runs.

## Acceptance criteria

1. `Date.prototype.set*` accept object args with `valueOf`/`toString` and
   call them exactly once, in the spec order.
2. `NaN` arg propagates: the date becomes Invalid and the return value is
   `NaN`.
3. `null` → 0, `true` → 1, `false` → 0, `undefined` → NaN.
4. Symbol arg throws TypeError.
5. `built-ins/Date/prototype/set*` failures drop by ≥75%.

## Files to inspect

- `src/codegen/expressions/builtins.ts` (setter dispatch, ~580-720)
- `src/codegen/type-coercion.ts` (ToNumber helper from #1434)
- `src/runtime.ts` (to-number host import or Invalid Date sentinel)
- `tests/issue-1440.test.ts`
