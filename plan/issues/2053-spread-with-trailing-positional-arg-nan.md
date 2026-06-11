---
id: 2053
title: "f(...arr, x) — trailing positional arg after spread silently miscompiles to NaN"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: spread
goal: core-semantics
related: [18, 1609, 1749, 2054]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2053 — spread followed by a trailing positional argument miscompiles

## Problem

A call mixing a spread with a **trailing** positional argument compiles cleanly
but produces NaN: the spread expansion assumes the spread covers all remaining
parameters and never consults the array's runtime length.

## Repro (verified on main)

```ts
function sum3(a: number, b: number, c: number): number { return a * 100 + b * 10 + c; }
export function t2(): number {
  const arr: number[] = [1, 2];
  return sum3(...arr, 3);   // JS: 123
}
```

| probe | wasm | node |
|-------|------|------|
| `sum3(...arr, 3)` | `NaN` | `123` |
| `sum3(...arr)` exact arity | OK | OK |
| `sum3(1, ...arr)` | OK | OK |

No compiler warning or error is emitted.

## Root cause

`src/codegen/expressions/extern.ts:507-518` (`compileSpreadCallArgs`, non-rest
path): when it meets a spread arg it unconditionally extracts
`remainingParams = paramTypes.length - paramIdx` elements from the spread vec —
i.e. it assumes the spread covers **all** remaining parameters. For
`sum3(...[1,2], 3)` it reads arr[0], arr[1], arr[2] (out of bounds →
default/NaN via `emitBoundsCheckedArrayGet`) and then compiles the trailing `3`
as a surplus stack value. The runtime length of the spread array is never
consulted.

## Fix direction

When non-spread args follow a spread, reserve the trailing positional slots:
extract `paramTypes.length - paramIdx - trailingCount` elements from the vec,
then compile the trailing args into the last slots. Longer-term, spread
expansion needs the vec's runtime `length` field (shorter-than-expected spreads
currently also silently read OOB) rather than callee arity.

## Acceptance criteria

- `f(...arr, x)` and `f(x, ...arr, y)` match Node for arrays whose lengths
  exactly fill the parameter list
- Spread shorter/longer than the remaining arity either matches JS semantics or
  produces a compile-time diagnostic (no silent NaN)
- Existing spread call sites unregressed

## Dupe check

Grepped spread issues: #18, #177, #213, #382, #409, #536, #761, #987, #1519,
#1609, #1749 — all done; cover new-expression spread, destructuring rest, object
spread, iterator override. None cover trailing-arg-after-spread in direct calls.
