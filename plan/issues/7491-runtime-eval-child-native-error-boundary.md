---
id: 7491
title: "runtime-eval shims leak a child module's native error struct instead of a JS SyntaxError/TypeError/…"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: runtime
goal: runtime-eval
related: [3632, 2960, 7439]
loc-budget-allow:
  # 2026-11-26: +1 line. The wrapExports catch arm becomes the shared
  # moduleExceptionToHost so the runtime-eval shim reuses it instead of keeping
  # its own tag unwrap; it needs _nativeErrorToHost, which lives here.
  - src/runtime.ts
---

# #7491: runtime-eval child exceptions cross the boundary as opaque structs

## Problem

On main c3b7be66:

```js
createNewFunctionShim()("a", "'use strict'; eval('public = 1;');")();
```

throws an object with a null prototype and no own keys, not a `SyntaxError`.
It keeps `tests/issue-3632-eval-early-errors.test.ts` ("preserves the
SyntaxError identity across a host new Function child boundary") red.

## Cause

Since the native semantic core (#6708), a child module's `new SyntaxError(…)`
(and every other native error: `TypeError` from `null.x`, `ReferenceError` from
an unbound name, `RangeError`, `Error`) is a Wasm-owned `$Error_struct`.
`callChildExport` in `src/runtime-eval.ts` removed the `__exn_tag` envelope
and rethrew the payload as is, so the caller saw the opaque struct. The
ordinary export boundary (`wrapExports` in `src/runtime.ts`) already
translates that struct to a real JS Error via `_nativeErrorToHost`; the shim
called the child's raw export and skipped it. Both `createNewFunctionShim` and
`createEvalShim` share `callChildExport`, so both leaked.

## Fix

- `src/runtime.ts`: the `wrapExports` catch arm (unwrap the module tag, then
  translate a native error struct) becomes the exported
  `moduleExceptionToHost(error, exports)`. `wrapExports` calls it, behaviour
  unchanged.
- `src/runtime-eval.ts`: `callChildExport` calls the same helper instead of its
  private copy of the tag unwrap. One boundary rule, no duplicate.

Not changed: a thrown non-error object (`throw {a: 1}`) still crosses as the
raw struct, exactly as it does through `wrapExports` today.

## Acceptance

- [x] `tests/issue-3632-eval-early-errors.test.ts` new-Function case passes
      (its other 2 red cases are S2's, PR #7439).
- [x] `tests/issue-7491-runtime-eval-native-error-boundary.test.ts`: 12 pins
      (SyntaxError, TypeError, RangeError, Error, null access, unbound name ×
      new Function and indirect eval) fail on main, pass here; a thrown
      primitive is unchanged.
- [x] Compiled Wasm identical: 100 `tests/equivalence` files × {host,
      standalone} hash the same before and after.
- [x] Code quality: no new duplicate; the shim's private tag unwrap is removed
      in favour of the shared boundary helper.
