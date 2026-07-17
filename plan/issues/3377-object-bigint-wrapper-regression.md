---
id: 3377
title: "Object(bigint) throws \"No dependency provided for extern class BigInt\" (regression of #1568)"
status: done
assignee: dev-builtins
completed: 2026-07-17
created: 2026-07-17
updated: 2026-07-17
priority: medium
feasibility: easy
task_type: bugfix
area: codegen, runtime
language_feature: bigint, object-coercion
goal: test262-conformance
related: [1568, 2728]
# (#3377) The __new_BigInt host handler belongs in runtime.ts alongside every
# other __new_*/__box_* import (a +6 LOC regression fix in its own module).
loc-budget-allow:
  - src/runtime.ts
---
# #3377 — `Object(bigint)` regressed: throws instead of boxing to a wrapper

## Problem

`Object(0n)` / `Object(BigInt(x))` throw at runtime with
`No dependency provided for extern class "BigInt"` instead of returning a
BigInt-wrapper object (§7.1.18 ToObject, Table 13; `typeof` → `"object"`).
This regresses #1568, whose test file `tests/issue-1568.test.ts` had 3 failing
rows on `main`:

```
typeof Object(0n) === 'object'
typeof Object(BigInt(42)) === 'object'
typeof Object(BigInt(0n)) === 'object'
```

## Root cause

`tryObjectCoercionCall` lowers `Object(bigint)` to `__new_BigInt(i64) -> externref`.
`import-manifest.ts` had **no dedicated route** for `__new_BigInt`, so it fell
through the generic `if (name.startsWith("__new_"))` arm to
`{ type: "extern_class", className: "BigInt", action: "new" }`. The runtime's
`extern_class` new path then looks up `builtinCtors["BigInt"]` — which does NOT
list `BigInt` (correctly, since `new BigInt(v)` throws: BigInt is not a
constructor) — and falls to the "No dependency provided for extern class" throw.
The dedicated builtin handler the #1568 calls-guards comment assumed existed was
never wired up.

## Fix

Mirror the #2728 `__new_Symbol` approach:

1. `src/compiler/import-manifest.ts` — route `__new_BigInt` through the dedicated
   runtime `builtin` handler (like `__new_AggregateError`/`__new_SuppressedError`/
   `__new_Symbol`) instead of the generic `extern_class` arm.
2. `src/runtime.ts` — add a `__new_BigInt` builtin handler that boxes via the
   spec's literal `Object(v)`. JS-BigInt-integration delivers the i64 arg as a JS
   `bigint` at the boundary, so `Object(v)` produces the wrapper directly.

## Acceptance

- `typeof Object(0n) === "object"`, `typeof Object(BigInt(42)) === "object"`.
- Bare `typeof 0n === "bigint"` (no over-boxing) — unchanged.
- `Object(number)`/`Object(string)`/`Object(boolean)` still box — unchanged.
- `tests/issue-1568.test.ts` (6 tests) all pass; `tests/issue-3377.test.ts` added.
