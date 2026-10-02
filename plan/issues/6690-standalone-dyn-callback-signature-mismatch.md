---
id: 6690
title: "standalone: array-method callback VARIABLE whose runtime signature differs from its static type traps (null deref on the closure carrier)"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: standalone
requested_by: ttraenkler/sendev-standalone
assignee: ttraenkler/sendev-standalone
related: [2717, 3015, 6695, 6696]
loc-budget-allow:
  # 2026-09-26 (#6690): +30 — map/forEach/filter/find*/some/every and
  # reduce/reduceRight now build their `call_ref` through the shared
  # `callbackInvokeInstrs` (array-callback-dyn-invoke.ts) so a dynamic
  # callback gets the signature-agnostic fallback; the typed argument lists
  # are hoisted into locals for that call, plus the 6-line import.
  - src/codegen/array-methods.ts
---

# #6690 — dynamic array callback with a mismatched runtime signature (standalone)

**Surfaced by** #2717's residuals: `flatMap` was routed around it (through the
recursive helper), plain `map` / `forEach` / `filter` / `reduce` still trapped.

## Reproduction

Typed:

```ts
function f(x: number): number { return x * 2; }
export function test(): number {
  const cb: (x: number) => number | string = f;  // static  (self, f64) -> union
  return [1, 2, 3].map(cb).length;               // runtime (self, f64) -> f64
}
// standalone: RuntimeError "dereferencing a null pointer"   (expected 3)
```

Untyped, two files (the variable's type is its FIRST initializer's):

```js
// lib.js
export function pick(n){ let cb = (x) => x > 1; if (n > 2) cb = (x) => (x > 1 ? "yes" : ""); return cb; }
// main.js
import { pick } from "./lib.js";
export function test(){ const a = [1, 2, 3]; const cb = pick(a.length); return a.filter(cb).length * 10 + a.map(cb).length; }
// standalone: trap (expected 23)
```

Also: fewer formals than the static type (`const cb: (x, i) => number = f`),
`let` reassigned to a closure with a different return, a conditional pick
between two closures, `reduce`/`reduceRight` with a union-return variable, and
any `any`-typed callback (which went to the `__call_1_f64` host import and could
not instantiate at all).

## Root cause

`setupArrayCallback` (`src/codegen/array-methods.ts`) recovers an externref
callback (#3015) as the canonical funcref wrapper of the callback's STATIC
signature and every loop called it with one `call_ref` of that signature:

```
local.get cb ; struct.get 0 ; <guarded funcref cast to the static sig> ; ref.as_non_null ; call_ref
```

The static signature is what the checker believes the variable holds, not what
the runtime value is. When the value's funcref has another result carrier
(`f64` vs `$AnyValue`) or arity, the guarded cast nulls and `ref.as_non_null`
traps — identically for every method, because they all share that sequence
(`buildClosureCallInstrs` + the reduce/reduceRight copies).

## Implementation Plan (executed)

1. New classified module `src/codegen/array-callback-dyn-invoke.ts`:
   - `setupDynCallbackFallback` — keep the raw externref callback plus a
     NULLABLE wrapper-root closure (no unconditional `ref.as_non_null`);
     pre-register `__apply_closure`, the canonical `__vec_externref` carrier
     and the union helpers while the caller still owns `fctx.body`.
   - `callbackInvokeInstrs` — the one invocation sequence. Without a fallback
     it emits exactly the historical typed call (JS-host byte-identical). With
     one: `closure non-null && funcref ref.test <static sig>` → the typed
     `call_ref`; otherwise the spec `Call(callbackfn, thisArg, «args»)` through
     the native `__apply_closure(fn, this, argsVec)` arity bridge (dispatches
     on the ACTUAL signature), args boxed into a `__vec_externref` (read
     directly by the bridge, #3673 — no object runtime pulled in), result
     coerced back to the static carrier: `$AnyValue` via `__any_from_extern`,
     and ToBoolean (not ToNumber) for predicate consumers.
   - `untypedDynCallbackClosure` — an all-externref wrapper for a callback with
     no single static signature (`any`, overloads), replacing the host bridge.
   - `reduceSpecArgs` — `(acc, element, index, array)` for the reducers.
2. `array-methods.ts`: the dynamic arm of `setupArrayCallback` uses (1);
   `buildClosureCallInstrs` / `compileArrayReduce` / `compileArrayReduceRight`
   build their call through `callbackInvokeInstrs`. One fix for all methods.
3. JS-host untouched: every new arm hangs off the `ctx.standalone` externref
   branch.

## Resolution (2026-09-26, sendev-standalone)

**Mechanism.** One shared invocation sequence (`callbackInvokeInstrs`) for
every array-method callback: typed `call_ref` when the runtime funcref has the
static signature, else the spec `Call` through the native `__apply_closure`
bridge with the result coerced back to the static carrier. Fixed once for all
methods; zero host imports.

**Evidence.**
- `tests/issue-6690-dyn-callback-signature-mismatch.test.ts`: the 14 standalone
  cases all FAIL on the parent (null-deref trap, or the `__call_N_f64` host
  import that cannot bind); 26/26 pass with the fix (12 JS-host controls pass
  on both).
- Scoped standalone test262 `built-ins/Array/prototype/{map,forEach,filter,reduce}`
  (908 rows, in-process runner): parent **715 pass / 193 fail**, fix
  **715 / 193** — byte-identical logs, zero losses (no row in the slice uses a
  signature-mismatched dynamic callback).
- JS-host byte-identical: 18-program HOF corpus (arrow/decl/param/thisArg/holes/
  reduce/reduceRight/find*) hashes equal parent vs fix under `--target gc`;
  standalone differs only on the dynamic-callback programs (≈ +1.5–2 KB for a
  small module — the bridge arm; the object runtime is NOT pulled in).
- hono JS-host dogfood 271/324 (unchanged).
- Existing suites: array-methods, functional-array-methods, flatmap-closure,
  issue-1522/2152/2717/2717-native-flatten/3015/3098/3162/3996-redux/4527/
  5319/6602 pass. `issue-2001-s1/s2` (3) and `issue-820l` (5) fail
  identically on the parent (pre-existing).
- `standalone-dynamic` lane (before → after, parent measured in this worktree):
  - hono: `host-import-error` "standalone binary retained 8 host import(s)" →
    same (568416 → 568583 bytes).
  - lodash: `optimization-error` "wasm-opt -O4 failed: [wasm-validator error
    in function baseUpdate] global.set value must have right type" → same.
  - prettier: `compile-error` "native generator lowering currently supports
    only sequential numeric yields in standalone/WASI targets (#680)" → same.

**Residuals.**
- #6695 — the DIRECT call `cb(3)` of the same variable (callable-param
  dispatch in `expressions/call-identifier.ts`) throws TypeError / null-derefs.
- #6696 — `string[].filter(cb)` with a dynamic callback is dropped entirely in
  standalone (silent `0`; pre-existing, found while building the corpus).
- JS-host divergence: `const cb = a.length > 5 ? f : g; a.map(cb)` (two
  closures of different return types) answers 3 instead of 13 in the host lane
  — pre-existing, not touched here.
