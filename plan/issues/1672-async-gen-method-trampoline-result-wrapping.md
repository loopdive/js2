---
id: 1672
title: "async / async-gen object+class method trampolines must return the real result, not null (completes #1671)"
sprint: 55
status: done
completed: 2026-05-27
feasibility: hard
reasoning_effort: max
depends_on: [1671]
references: [1669, 1602, 621, 623]
goal: test262-conformance
---

## Problem

After #1671 recovered the SYNC object/class method dispatch path, a residual
cluster of ~59 test262 failures remained, all in
`language/expressions/{object,class}` async / async-generator methods
(`async-gen-meth` + `method-definition`), plus 6
`built-ins/AsyncFromSyncIteratorPrototype/{next,return,throw}` `compile_error`s.

Symptoms:
- runtime: `Cannot read properties of null (reading 'next')` — `obj.method(...)`
  returned a null externref, so the test's `result.next()` / iteration
  dereferenced null.
- compile: `Compiling function #NN:"__obj_meth_tramp_*_next" failed: type error`
  — invalid wasm in the method-as-closure-value trampoline at the
  iterator-result accessor path.

## Root cause (two independent bugs, both surfaced by this cluster)

The hypothesis going in was "the async/isGenerator trampoline returns a null
sentinel instead of materializing the generator/promise result." The trampoline
itself turned out to be correct; the real causes were upstream and downstream of
it.

### Bug 1 — variable redeclaration + global-promotion store ordering
`src/codegen/statements/variables.ts`

The cluster's procedurally-generated tests share the shape:

```js
var obj = {};                       // (1) typed {}
var obj = { async *method(...) {     // (2) redeclaration; body references obj
  assert.sameValue(aObj, obj);       //     -> self-reference capture
} };
var ref = obj.method;                // obj is typed {} => obj.method is `any`
ref(...).next().then(...)            // => inline dynamic-dispatch call path
```

Because `obj`'s static type is `{}` (from the first declaration), `obj.method`
is `any` and `ref(...)` lowers to `tryEmitInlineDynamicCall` in
`expressions/calls.ts` — a `ref.test (ref <closureStruct>)` chain.

While compiling the object-literal initializer (2), the async-gen method body's
reference to `obj` triggers `promoteAccessorCapturesToGlobals`
(`closures.ts`) MID-initializer. That helper:
1. copies the CURRENT local value of `obj` into a fresh `__captured_obj` global —
   but at that point the local still holds the value from declaration (1)
   (`__new_plain_object` / undefined), i.e. a STALE value;
2. deletes `obj` from `fctx.localMap` so later reads resolve via the global.

The subsequent var-declaration store wrote the freshly-built struct only to the
LOCAL. Every later read of `obj` (including `var ref = obj.method`) then went
through the stale captured global → the object had no `method` field → dynamic
dispatch `ref.test` failed → the call returned `ref.null.extern` → `.next()`
dereferenced null.

Verified by replacing the dynamic-dispatch default arm with `unreachable`:
the runtime error flipped from "reading 'next' of null" to "unreachable",
proving the dispatch fell through (the receiver was not the expected closure
struct because `obj` itself was the stale value).

**Fix**: in `compileVariableStatement`, record whether `name` was already a
captured global BEFORE compiling the initializer. If the initializer promoted it
(captured global appeared during this init) and the store wrote a real local,
re-sync the captured global from the local after the store (with a type coercion
when the global was widened to `ref_null`/`externref`). Narrow guard:
`capturedGlobalIdx !== undefined && !wasCapturedGlobalBefore && localIdx >= params.length`.

### Bug 2 — trampoline result-type reconciliation
`src/codegen/closures.ts` (`finalizeMethodTrampolines`)

The 6 AsyncFromSyncIterator `compile_error`s came from the
method-as-closure-value trampoline. `emitObjectMethodAsClosure` captures the
method's result type at emit time (`results[0]`). For the iterator-result
accessor path, the method body later resolves its return to a
STRUCTURALLY-DISTINCT struct type than the one captured (two iterator-result
struct shapes built at different points). `finalizeMethodTrampolines` rebuilt the
body and tried to reconcile the result via `coercionInstrs(methodResult,
wrapperResult)` — but `coercionInstrs` is a NO-OP when `from.kind === to.kind`
(both `ref`). So the trampoline returned `ref <methodTypeIdx>` while its declared
func type was `ref <wrapperTypeIdx>` → invalid module (result/fallthru type
error compiling `__obj_meth_tramp_*_next`).

**Fix**: when both results are `ref`/`ref_null` with differing `typeIdx`, emit an
explicit `ref.cast` (or `ref.cast_null` for a nullable wrapper result) to the
wrapper's declared result type instead of relying on the same-kind no-op
coercion. At runtime the generator/iterator-result object is a valid instance of
the wrapper's result shape, so the cast succeeds.

## Files changed
- `src/codegen/statements/variables.ts` — captured-global re-sync after
  promotion-during-own-initializer (Bug 1).
- `src/codegen/closures.ts` — `finalizeMethodTrampolines` result cast for
  differing-typeIdx ref results (Bug 2).
- `tests/issue-1672-async-gen-method-trampoline.test.ts` — unit (compileToWasm)
  + test262 e2e regression guards.

## Why not the original hypothesis
The async/isGenerator method bodies DO materialize and return the real
generator/async-iterator/promise object as externref (`literals.ts`
`isGeneratorMethod` path → `__create_async_generator`). The trampoline forwards
that result faithfully. The null came from the receiver/`obj` being stale (Bug 1),
and the invalid wasm from result-type reconciliation (Bug 2) — not from a null
sentinel in the trampoline's async path. Kept #1671's sync dispatch + receiver
lowering intact (regression guard test added).

## Validation
- New unit + e2e tests pass at runtime (11/11).
- Curated cluster (object method-definition + class async-gen-method +
  AsyncFromSyncIteratorPrototype, ~150 files): null-deref fails and the 6
  trampoline `compile_error`s now PASS; remaining fails are pre-existing
  unrelated limitations (NaN/`''` SameValue in the f64-param dynamic path,
  eval-scope SyntaxError, TDZ ReferenceError) and 2 unrelated for-await
  rejection CEs.
- `#1671`/`#1669`/`#1602` + closure/generator suites unaffected.
- `tsc --noEmit` clean; biome clean on changed lines (pre-existing legacy
  violations in the touched files are not newly introduced).
- Expected ~+59-65 test262 pass (restores the #593 peak of 29,603).

## Suspended/blocked
None.
