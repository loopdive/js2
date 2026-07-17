---
id: 3342
title: "standalone: Object.values(o).join / Object.getOwnPropertyNames(o).join misclassify receiver as Uint8ClampedArray → leak env::Uint8ClampedArray_join"
status: done
completed: 2026-07-17
assignee: ttraenkler/dev-1044
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
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/expressions/calls-closures.ts
origin: "carved out of #3155 (fix-standalone-object-keys-join, opus-c 2026-07-17) — Object.keys().join was fixed via the native externref-join path, but Object.values()/getOwnPropertyNames() take a DIFFERENT, distinct-root-cause path."
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

1. [x] `Object.values(o).join(sep)` and `Object.getOwnPropertyNames(o).join(sep)`
   compile with `target: "standalone"` to a module with **no** `env::*` import
   and produce the correct joined string (verified in-wasm, mirroring
   `tests/issue-3155.test.ts`).
2. [x] Add coverage — new `tests/issue-3342.test.ts` (8 cases).
3. [x] No test262 regression; host-lane byte-identity.

## Resolution (2026-07-17, dev-1044)

**Root cause was NOT return-type inference** — it was the `as any` cast (and
any `any`-typed array receiver). With the receiver statically `string[]`
(no cast), `.join` rides the native array-`join` dispatch (`receiverIsExternref`
arm, #3155) and is already host-free. With the receiver statically `any`, the
call reaches `tryExternClassMethodOnAny` (`calls-closures.ts`), whose
first-match loop bound `.join` to the FIRST registered extern class declaring a
`join` method — a TypedArray, `Uint8ClampedArray` — emitting the unsatisfiable
`env::Uint8ClampedArray_join`.

**Fix**: in `tryExternClassMethodOnAny`, under `ctx.standalone || ctx.wasi`,
route `methodName === "join"` to the #3155 native externref-array walk via the
new `compileArrayJoinExternForAny` (`array-methods.ts`, gated on `noJsHost`,
returns null before emitting when unavailable). This mirrors the existing
`get`/`set`/`has`/… standalone refusal block above it. A genuine TypedArray
receiver typed `any` rides the same native walk correctly, so it is a general
externref-array-`join` fix, not an Object.values special-case.

**Host lane**: the guard is skipped when neither `standalone` nor `wasi`, so
JS-host still binds `Uint8ClampedArray_join` (satisfiable there) — byte-identical.

**Note on wasi**: `Object.values`/`Object.keys` themselves currently return an
empty result under `--target wasi` (a pre-existing object-model limitation that
also affects the #3155 non-cast path — orthogonal to this issue). The fix
converts the cast-path wasi *crash* (unsatisfiable import) into that same
contained empty-result behaviour; standalone is fully correct.

Files: `src/codegen/array-methods.ts` (new `compileArrayJoinExternForAny`),
`src/codegen/expressions/calls-closures.ts` (dispatch + import),
`tests/issue-3342.test.ts`.
