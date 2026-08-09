---
id: 3429
title: "Host assert.throws: expected error constructor rendered as internal 'wasmClosureDynamicBridge' (544 records) under oracle v8"
status: done
completed: 2026-07-20
sprint: 73
created: 2026-07-18
updated: 2026-07-21
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: test262-runner, codegen
language_feature: error-constructors
es_edition: multi
goal: test262-conformance
related: [3370, 1104, 3486]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): host `other` sub-bucket @ oracle 8."
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls.ts
---

# #3429 — assert.throws constructor identity leaks internal 'wasmClosureDynamicBridge'

## Problem

544 host tests fail with the internal implementation name
`wasmClosureDynamicBridge` appearing where an error-constructor identity should
be, in `assert.throws` verdicts:

```
Expected a wasmClosureDynamicBridge but got a TypeError
Expected a wasmClosureDynamicBridge to be thrown but no exception was thrown at all
?GetValue(lhs) throws. Expected a wasmClosureDynamicBridge but got a Array
```

Samples:
```
test/built-ins/Array/prototype/reduceRight/15.4.4.22-4-11.js
test/language/expressions/assignment/dstr/array-rest-lref-err.js
test/language/expressions/division/order-of-evaluation.js
test/language/expressions/compound-assignment/S11.13.2_A7.8_T1.js
test/language/expressions/compound-assignment/S11.13.2_A7.8_T3.js
```

## Root cause (hypothesis)

Consequence of #3370. The synthetic wrapper previously shimmed `assert.throws`;
the authoritative harness now does the real constructor-identity check
(`err.constructor === TypeError`). The expected-constructor argument passed to
`assert.throws` (e.g. `TypeError`, `ReferenceError`) is being represented at
runtime as the internal `wasmClosureDynamicBridge` closure rather than the named
error constructor, so the harness's identity/`.name` read returns
`wasmClosureDynamicBridge`. Two failure shapes appear:

- `Expected a wasmClosureDynamicBridge but got a TypeError` — the thrown error is
  correct (a real `TypeError`) but the *expected* constructor reference is
  mangled, so the identity comparison fails a test that should pass.
- `Expected a wasmClosureDynamicBridge ... but no exception` / `... but got a
  Array` — genuinely no-throw or wrong-throw cases, but the message still shows
  the constructor identity leak.

The fix is to give error constructors passed as first-class values (into
`assert.throws`) a correct constructor identity / `.name`, rather than a dynamic
bridge closure. Overlaps #1104 (wasm-native error construction).

## Acceptance criteria

- A minimal `assert.throws(TypeError, () => { throw new TypeError() })` passes;
  the verdict message names `TypeError`, never `wasmClosureDynamicBridge`.
- The `wasmClosureDynamicBridge` string no longer appears in any assert.throws
  verdict; the 544-record class drops to ~0 (remaining genuine no-throw failures
  reclassify to their real cause).

## Cross-reference

Consequence of #3370 (real constructor-identity behavior). Related: #1104
wasm-native error construction.

## Implementation Plan (architect, 2026-07-19 — reproduced through the real runner; leading mechanism identified)

### Repro (confirmed)

Both failure shapes reproduce via `runTest262File` (host lane, literal harness):
- `built-ins/Array/prototype/reduceRight/15.4.4.22-4-11.js` →
  `Expected a wasmClosureDynamicBridge but got a TypeError`
- `language/expressions/division/order-of-evaluation.js` →
  `?GetValue(lhs) throws. Expected a wasmClosureDynamicBridge but got a Array`

### Root cause (leading hypothesis — receiver shift at the closure method-call bridge)

A bare `TypeError` identifier as a VALUE compiles correctly to the real host
constructor via the `global_TypeError` import (verified by WAT: `take(TypeError)`
emits `call $global_TypeError`) — the expected-ctor ARGUMENT is NOT mangled at
the read site, with or without `new TypeError()` elsewhere in the module.

The corruption happens at the CALL of `assert.throws(...)`. `assert.throws` is a
compiled closure stored as a property of the function-object `assert`
(function-with-properties sidecar); invoking it routes through the host
method-call machinery (`__extern_method_call`, `src/runtime.ts:~10490`) onto the
`wasmClosureDynamicBridge` wrapper (`src/runtime.ts:1246`). That wrapper's
METHOD-call arm (`src/runtime.ts:~1262`, `this !== undefined && this !==
globalThis`) dispatches via `__call_fn_method_N(closure, receiver, ...args)`
(`emitClosureMethodCallExportN`, `src/codegen/index.ts`). If the compiled
`assert.throws` closure's formals receive the RECEIVER as formal #0 (a plain
function expression has no `this` slot in its wrapper signature), every
argument shifts by one:

- `expectedErrorConstructor` ← the receiver = the `assert` bridge function,
  whose host-visible `.name` is **`wasmClosureDynamicBridge`** — matches shape 1
  verbatim (`Expected a wasmClosureDynamicBridge but got a TypeError`);
- `func` ← the real `TypeError` ctor — `typeof func === "function"` passes,
  `func()` = `TypeError()` returns (never throws) → matches shape 2 verbatim
  (`…to be thrown but no exception was thrown at all`).

Both observed messages are exactly predicted by a one-slot receiver shift.
Note `assert.sameValue` does NOT hit this (it dispatches through a different,
statically-recognized path — the dev should confirm which gate diverts
`throws`: possibly arity, possibly the `func()` dynamic-call body shape).

### Fix steps

1. **Confirm the shift** with a 5-line probe through `runTest262File`: harness +
   `assert.throws(TypeError, function(){ throw new TypeError(); })`, plus a
   temporary log of the first formal inside a compiled 3-param function-property
   closure invoked host-side. Compare dispatch arms in
   `emitClosureMethodCallExportN` (`src/codegen/index.ts`) — specifically how
   the receiver slot maps onto formals for NON-method closures (function
   expressions assigned as properties) vs real methods.
2. **Fix at the dispatch layer**, not per-builtin: the method-call arm must pass
   the receiver ONLY to closures that bind `this` (method-shaped wrappers); a
   plain function-expression closure gets `args` unshifted. The `__closure_arity`
   probing in the bridge (runtime.ts:1244-1290, the #2623 P-7/B-1 block) already
   distinguishes arity — extend the closure metadata with a "binds this" bit if
   the wrapper type alone can't discriminate.
3. Re-run the 544-record sample list; residual genuine no-throw cases will
   reclassify to their real cause (some land in #3430).

### Edge cases
- Do not regress real method dispatch (`obj.m(...)` with receiver) — the #2664
  acorn omission hazard and the #2623 exact-arity dispatch tests must stay green.
- `assert.throws.call(assert, TypeError, fn)` / detached
  `var t = assert.throws; t(TypeError, fn)` should behave identically after the
  fix (receiver undefined → plain-call arm).
- Overlaps #1104 (wasm-native error construction) only for the `.name` read;
  the shift fix does not depend on it.

### How to test
- `tests/issue-3429.test.ts`: minimal `assert.throws(TypeError, thrower)` via
  `runTest262File` must pass; message must never contain
  `wasmClosureDynamicBridge`.
- Scoped: the 5 sample files in this issue + a compound-assignment
  `S11.13.2_A7.8_T*` pair.

## Resolution (2026-07-20 — dev implementation)

**The architect's "receiver shift" hypothesis above was empirically
DISPROVEN.** Instrumented `_wrapWasmClosureUnknownArity` and
`__extern_method_call` directly (temporary `console.error` tracing, since
removed) and confirmed: args cross the host boundary unshifted, in the
correct order and count. `assert.throws(TypeError, thrower)` already passed
BEFORE any fix — native builtins (real `TypeError`/`RangeError`/...) are never
wrapped by the closure bridge (`_isWasmStruct` is false for them), so they
were never affected.

**Real root cause**: a USER-DEFINED function/class value (the pervasive
test262 idiom `function MyError(){}` / the harness's own `Test262Error`)
crossing the JS-host boundary as a first-class value (e.g. the
`expectedErrorConstructor` argument of `assert.throws(MyError, fn)`) gets
wrapped by `_wrapWasmClosureUnknownArity` (`src/runtime.ts`) into a JS
function literally named `wasmClosureDynamicBridge` (its own declared
function-expression name). Reading `.name` on that bridge — exactly what
`assert.throws`'s message construction does — returned the bridge's own
name, not the wrapped closure's real declared name.

**Fix** (`src/codegen/expressions/helpers.ts`,
`maybeStampCompiledFunctionArgName` + `resolveCompiledFunctionArgName`): when
an argument expression crossing a JS-host-delegated call
(`__extern_method_call`) is statically a bare `Identifier` bound to a named,
user-compiled `FunctionDeclaration`/`FunctionExpression`/`ClassDeclaration`
(never an ambient `declare`d builtin), stamp its real declared name into the
value's `_wasmStructProps` sidecar via `__extern_set(val, "name", <name>)`
BEFORE it crosses. `_wrapWasmClosureUnknownArity` was extended to read that
stamp (mirrors the existing `.name`/`.length` sidecar read already used by
`_wrapCallableForHost`). Wired at the three JS-host call sites that marshal
arguments across `__extern_method_call`: `call-receiver-method.ts` (#799 WI3
generic any-receiver dispatch — the one hit by `assert.throws`), `calls.ts`
(`emitFnctorSubclassDynamicMethodCall`), `new-super.ts`
(`emitSuperExternMethodCall`). Gated to JS-host mode only (`!ctx.standalone
&& !ctx.wasi`) — `wasmClosureDynamicBridge` is a JS-host-only construct.

**Verified via `builtin-fn-meta.ts`-style WAT inspection** that two
differently-named zero-capture closures share ONE structural closure struct
type — ruling out a cheap `ref.test`-per-type dispatcher (would have required
minting a per-declaration struct subtype for every named function
declaration, a much larger change; discussed and scoped down with the tech
lead before implementation).

**Known limitation, NOT fixed here**: a separate, pre-existing bug (**#3486**,
filed alongside this fix) means a *caught* custom-exception instance's
`.constructor` resolves to a generic `"Array"`-named mirror instead of its
real constructor — so `assert.throws(MyError, () => { throw new MyError() })`
still does not fully PASS end-to-end after this fix; it fails with a
correctly-named message instead of the `wasmClosureDynamicBridge` one. This
is why the practical pass-flip count on the 544-record class is smaller than
a naive reading suggests — most records reclassify (correct constructor name,
still failing for the #3486 reason) rather than flip to pass outright. This
matches the acceptance criteria as written ("remaining genuine no-throw
failures reclassify to their real cause").

### Test Results

All 5 sample files from this issue's `## Problem` section no longer contain
the string `wasmClosureDynamicBridge` in their verdict message (verified via
`runTest262File`, host lane):

| File | Before | After |
| --- | --- | --- |
| `built-ins/Array/prototype/reduceRight/15.4.4.22-4-11.js` | `Expected a wasmClosureDynamicBridge but got a TypeError` | `Expected a Test262Error but got a TypeError` |
| `language/expressions/assignment/dstr/array-rest-lref-err.js` | (bridge name) | `Expected a Test262Error to be thrown but no exception was thrown at all` |
| `language/expressions/division/order-of-evaluation.js` | `Expected a wasmClosureDynamicBridge but got a Array` | `Expected a MyError but got a Array` |
| `language/expressions/compound-assignment/S11.13.2_A7.8_T1.js` | (bridge name) | `Expected a DummyError but got a Array` |
| `language/expressions/compound-assignment/S11.13.2_A7.8_T3.js` | (bridge name) | `Expected a DummyError but got a Array` |

All 5 still FAIL — none of them were the trivial "identity actually matches"
case; each reclassifies to a real cause (mostly #3486's caught-exception
`.constructor` bug, resolving to `"Array"`). New regression test
`tests/issue-3429.test.ts` (4 cases) verifies: (1) the native-builtin control
case (`assert.throws(TypeError, ...)`) stays green, (2)/(3) a user-defined
constructor's real name substitutes in both the wrong-throw and (4) the
no-throw message shapes, and that `wasmClosureDynamicBridge` never appears.
Scoped local equivalence checks (`closure-push-host-callback`,
`optional-direct-closure-call`, `super-element-access`,
`super-property-access`, `illegal-cast-assert-throws`,
`scope-and-error-handling`, `try-catch-throw`, `tdz-reference-error`) show no
new regressions — pre-existing failures on `optional-direct-closure-call.test.ts`
and `tdz-reference-error.test.ts` were confirmed present on a clean
`origin/main` checkout (unrelated to this change) via A/B testing.

Follow-up filed: **#3486** — caught custom-exception `.constructor` resolves
to `Array`, not the real constructor (the blocker for full end-to-end pass on
the majority of this record class).
