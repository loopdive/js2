---
id: 3342
title: "standalone: Object.values(o).join / Object.getOwnPropertyNames(o).join misclassify receiver as Uint8ClampedArray → leak env::Uint8ClampedArray_join"
status: done
completed: 2026-07-17
assignee: ttraenkler/opus-e
sprint: current
created: 2026-07-17
priority: medium
horizon: s
feasibility: medium
model: opus
task_type: fix
area: codegen
language_feature: standalone-completeness, array-join, type-inference
goal: standalone-parity
related: [3155, 3170]
origin: "carved out of #3155 (fix-standalone-object-keys-join, opus-c 2026-07-17) — Object.keys().join was fixed via the native externref-join path, but Object.values()/getOwnPropertyNames() take a DIFFERENT, distinct-root-cause path."
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
---

# #3342 — standalone `Object.values(o).join` / `Object.getOwnPropertyNames(o).join` leak `env::Uint8ClampedArray_join`

## Source

Surfaced while fixing **#3155** (standalone `Object.keys(o).join(sep)`). That fix
added a native externref-`join` path (`compileArrayJoinExternNative`,
array-methods.ts) reached when the join-dispatch classifies the receiver as an
externref. `Object.keys(o).join(...)` now works host-free standalone.

But `Object.values(o).join(...)` and `Object.getOwnPropertyNames(o).join(...)`
take a **different** dispatch path and are NOT fixed by #3155.

## Problem (measured, current main + #3155 branch)

```ts
export function test(): boolean {
  const o: any = { a: 1, b: 2 };
  return (Object.values(o) as any).join(",") === "1,2"; // standalone
}
```

compiles (with `target: "standalone"`) to a module importing
`env::Uint8ClampedArray_join` — an unsatisfiable host import (module fails to
instantiate against `{}`). Identical symptom for
`Object.getOwnPropertyNames(o).join(...)`. `Object.keys(o).join(...)` (fixed by
#3155) and `Object.entries(o).length` are host-free.

## Root cause (to confirm)

The `join` receiver-type probe (`array-methods.ts`, the `receiverIsExternref` /
`actualType` classification around the method dispatch) classifies the
`Object.values` / `Object.getOwnPropertyNames` result as a **Uint8ClampedArray**
rather than a boxed externref array, so the dispatch routes to the TypedArray
`join` lowering (`env::<TA>_join`) instead of the externref path that #3155 made
native. Why those two builtins' results infer to a clamped typed array (while
`Object.keys` infers to a plain array/externref) is the thing to pin down — most
likely a return-type / lib.d.ts inference quirk or a probe misread of the
runtime shape.

## Fix direction

- Confirm via a WAT/import probe which dispatch arm is chosen for the
  `Object.values` / `getOwnPropertyNames` receiver (TypedArray-`join` vs
  externref-`join`).
- Correct the classification so these externref-array results take the native
  externref-`join` path (`compileArrayJoinExternNative`, already host-free), OR
  give the TypedArray-`join` host arm a `noJsHost` native fallback if the
  receiver genuinely is a native typed-array here.
- Do NOT add a host import without a standalone fallback (dual-mode contract).

## Acceptance

1. `Object.values(o).join(sep)` and `Object.getOwnPropertyNames(o).join(sep)`
   compile with `target: "standalone"` to a module with **no** `env::*` import
   and produce the correct joined string (verified in-wasm, mirroring
   `tests/issue-3155.test.ts`).
2. Add coverage to `tests/issue-3155.test.ts` (or a new `tests/issue-3342.test.ts`).
3. No test262 regression; host-lane byte-identity.

## Resolution (2026-07-17, opus-e)

**Root cause (confirmed):** the `as any` cast on the receiver — not the choice
of `Object.values`/`getOwnPropertyNames` vs `keys` — is the trigger. Without a
cast, all three infer a concrete array type and dispatch through the
array-methods native externref path (host-free since #3155). With `as any` the
receiver is `any`-typed, so the call reaches the `any`-receiver fallback
`tryExternClassMethodOnAny` (`src/codegen/expressions/calls-closures.ts`). That
helper iterates `ctx.externClasses` in insertion order and first-matches any
class declaring a `join` method with all-externref params. A TypedArray view
(`Uint8ClampedArray`) is registered before `Array`, so the call bound
`env::Uint8ClampedArray_join` — an unsatisfiable host import under standalone.
(All three of keys/values/getOwnPropertyNames leaked identically once cast.)

**Fix:** added a `noJsHost`-gated guard in `tryExternClassMethodOnAny` that
routes a `join` on an `any`-typed receiver to the native externref `join`
(`compileArrayJoinExtern`, host-free under `noJsHost` since #3155) *before* the
first-match loop can bind the TypedArray host import. The JS-host lane is
untouched (byte-identical). `compileArrayJoinExtern` was exported from
`array-methods.ts` for reuse.

**Files:** `src/codegen/expressions/calls-closures.ts`,
`src/codegen/array-methods.ts` (export), `tests/issue-3342.test.ts` (new, 7
cases: values/getOwnPropertyNames/keys as-any, multi-char + default separator,
empty object, plain-array-as-any regression guard).
