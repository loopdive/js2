---
id: 6900
title: "`xs.sort(cmp)` on an untyped compiled array first-matches `Uint8ClampedArray_sort` and answers undefined (hono accepts 3/8)"
status: done
sprint: current
created: 2026-10-07
updated: 2026-10-09
completed: 2026-10-07
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: runtime
goal: dogfood
related: [6860, 6901, 6902]
func-budget-allow:
  # 2026-10-09 (#6900): generic extern-method shim delegates a vec receiver to `__extern_method_call` (+17); moving the callback-slot table out shrinks runtime.ts net
  - src/runtime.ts::resolveImport
---

## Problem

hono `src/helper/accepts/accepts.test.ts` was 3/8 on main: three rows threw
`Cannot read properties of null (reading 'find')`, two more failed downstream of
the same call.

```js
var defaultMatch = (accepts2, config) => {
  const accept = accepts2.sort((a, b) => b.q - a.q).find((x) => supports.includes(x.type));
```

`accepts2` is untyped. The any-receiver first-match binder
(`tryExternClassMethodOnAny`, `calls-closures.ts`) binds `.sort` to the first
ambient extern class that declares it — `Uint8ClampedArray_sort`. The receiver
is a compiled WasmGC vec: the generic extern-method shim's `self[m]` and the
struct field reader both miss, so the call answered `undefined` WITHOUT sorting.
Reduced: `const f = (xs) => xs.sort(cmp); f(a) === a` is `false`.

## Implementation Plan

Runtime-only (`src/runtime.ts`, the `invokeMethod` body of the generic
extern-class method shim). When the method does not resolve on the receiver and
the receiver is a compiled vec (`_isWasmVec`, the positive `__is_vec`
discriminator), delegate to the canonical `__extern_method_call` dispatcher —
it already serves vec receivers through the Array facade with mirror
write-back (#3603) and returns the vec itself for receiver-returning methods.
Resolve that dispatcher lazily, once per shim. No codegen change, no new import.

## Resolution

Implemented as planned. hono `accepts.test.ts` 3/8 → 7/8 with this alone; 8/8
together with [#6901](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6901-uninitialized-class-field-reads-null)
(the last row is a `c.body()` response whose status field was `null`).
Regression: `tests/issue-6900-hono-accepts-concurrent-client.test.ts`.
