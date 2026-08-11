---
id: 3140
title: "Standalone: Function.prototype.bind on a closure returns a non-callable — blocks the entire modern test262 TypedArray harness (makeCtorArg)"
status: done
completed: 2026-07-11
assignee: ttraenkler/fable-harvest3
created: 2026-07-11
updated: 2026-08-11
priority: high
task_type: bug
area: codegen, runtime
language_feature: function-bind
goal: standalone
sprint: 71
horizon: m
related: [2872, 2860, 2876, 3016]
umbrella: 2860
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/registry/types.ts
  - src/codegen/closure-classifier.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
origin: "2026-07-11 — discovered by fable-harvest3 during #2872 slice 1 (dynamic TA construction): every makeCtorArg-style TypedArray test fails at the HARNESS level because argFactory.bind(undefined, constructor) is not callable"
---

## Implemented (2026-07-11, fable-harvest3)

**Root cause (two layers):** (a) the typed `compileFunctionBind` route degraded
to *identity-bind* under standalone (returned the target, DROPPED partial
args — the #1632a documented gap); (b) an `any`-typed receiver (`argFactory`
is an array element — no TS call signatures) never routed there at all: it fell
to the open-object dispatcher arm and returned `undefined`.

**Fix — native `$__bound_fn {target, thisArg, boundArgs}` carrier:**

1. `getOrRegisterBoundFnType` (registry/types.ts), memoized on
   `ctx.boundFnTypeIdx`; byte-inert for bind-free modules.
2. `compileFunctionBind` standalone arm mints the carrier (spec §20.2.3.2
   evaluation order: target → thisArg → partials, each once).
3. Any-receiver `.bind` routes through **reserve-then-fill `__bind_dyn`**
   (object-runtime.ts): the callable gate needs the COMPLETE closure-classifier
   root list, only settled at finalize (#1896 hazard) — callable → mint;
   anything else → the legacy `__extern_method_call(recv, "bind", args)` route
   (undefined), so non-callables keep prior behavior.
4. `fillApplyClosure` gains a `$__bound_fn` front-guard (the #3031 $Proxy
   ladder pattern): unwraps ONE bound layer per hop — merged = boundArgs ++
   args, [[BoundThis]] wins over the caller receiver (§10.4.1.1), recursion on
   the target composes bound-of-bound.
5. `tryEmitInlineDynamicCall` (bare `bound(...)` calls) gains an unwrap arm,
   pre-scanned via `sourceHasBindCall` for compile-order independence.
6. The closure classifier counts the carrier callable → `typeof bound ===
   "function"`, `__is_closure`, typeof-object exclusion — one predicate, all
   consumers.

**Measured (standalone lane, local scans vs pre-fix):**
`built-ins/Function/prototype/bind`: 16 → 27 pass (**+14 / −3**; the 3 flips
are `Object.defineProperty`-on-the-carrier tests that previously passed by the
identity-bind accident). `built-ins/TypedArray/prototype`: unchanged — the
harness's NEXT gate is `Array.from({length}, fn)` / `Array.from(iterable)`
(leaks `__make_callback` / `__array_from`), which is the follow-up lever.

**Residuals (follow-ups):** bound-fn `.length`/`.name` fidelity (carrier
reports arity 0); `Object.defineProperty` on a bound fn; `new bound(...)`
[[Construct]]; the `Array.from` standalone gap below.

## ES5 stored-call follow-up (2026-08-11)

The native carrier itself worked for a bound function called from the same
local expression, but a carrier stored in a module binding still trapped:

```js
function add(a, b) { return a + b; }
var add4 = add.bind(undefined, 4);
add4(3); // null dereference before this slice
```

The identifier-call path trusted TypeScript's inferred callable signature and
first cast the live value to an ordinary funcref-wrapper struct. A
`$__bound_fn` is deliberately a distinct carrier, so that cast returned null;
signature-directed argument coercion could then trap before the existing
bound-function arm in `tryEmitInlineDynamicCall` / `__apply_closure` ever saw
the value.

The fix recognises only a binding whose initializer is statically a
`.bind(...)` result (the existing `calleeIsBoundFunctionVar` predicate) and
routes that call through the canonical native callable ladder before the
ordinary typed-wrapper fast path. It does not add a second bind implementation:
argument packing, `[[BoundArguments]]`, `[[BoundThis]]`, and bound-of-bound
composition remain owned by `$__bound_fn` plus `__apply_closure`.

Measured on standalone, exact ES5 bind rows, main `c0b422b3792699` versus this
change:

- `S15.3.4.5_A1.js`: fail (null dereference) -> pass
- `S15.3.4.5_A2.js`: fail (null dereference) -> pass
- `S15.3.4.5_A4.js`: fail (null dereference) -> pass
- `15.3.4.5-3-1.js`: fail (null dereference) -> still fails, but now executes
  the bound target; its residual is `new Boolean(true) == true` wrapper
  coercion, not bind argument delivery

Net: **0/4 -> 3/4**, with the bound-argument probe confirming all five facts
(`x`, `y`, `arguments[0]`, `arguments[1]`, and `arguments.length`) after the
module-global round trip.

### Exact IR boundary

This repair is pre-IR adapter work, not a new legacy semantic model. The IR has
no bound-function carrier/call node today, and
`src/ir/fnctor-method-edges.ts` explicitly rejects any `.bind` invocation alias
from the IR function-object graph. Consequently the stored carrier call reaches
`compileIdentifierCall` only after IR selection has declined it. A future IR
slice should represent bind creation and invocation explicitly and lower to the
same `$__bound_fn` / `__apply_closure` runtime primitives; once that exists,
this narrow syntactic adapter can be retired.

## Banked intel — the NEXT rock on this line: `Array.from` standalone (per lead throttle, 2026-07-11)

Deliberately NOT started this budget window (lead directive). Verified probe
(mini repro, current main + this fix):

```ts
// leaks env::__make_callback + env::__array_from → instantiation failure
function makeArray(TA: any, x: any) {
  if (isPrimitive(x)) {
    var n = Number(x);
    if (!(n >= 0 && n < 9007199254740992)) return x;
    return Array.from({ length: n }, function () { return "0"; }); // ← __make_callback
  }
  return Array.from(x); // ← __array_from
}
```

- This is the test262 harness `makeArray`/`makeArrayLike`/`makeIterable`/
  `makeArrayBuffer` COMMON PREFIX (`harness/testTypedArray.js`) — with #2872
  slice 1 (dynamic TA construction, PR #2881) and this bind fix (PR #2884)
  landed, `Array.from` is the LAST harness-level gate before the whole
  makeCtorArg-style `built-ins/TypedArray/prototype/**` family (hundreds of
  files) can execute their bodies. Highest-multiplier next slice.
- Two distinct shapes to fix (both leak on the default `Array.from` call
  path in calls.ts):
  1. `Array.from(arrayLikeOrIterable)` — 1-arg → leaks `env::__array_from`.
     A native `__array_from_iter_n` ALREADY exists (#2904/#3100 S4,
     `ensureNativeArrayFromIterN`, iterator-native.ts) and `ensureLateImport`
     routes `__array_from_iter_n` to it under noJsHost — the 1-arg
     `Array.from` call site just doesn't route through it for all shapes.
  2. `Array.from(x, mapFn)` — mapper → leaks `env::__make_callback` (host
     closure bridge). Standalone should invoke the mapper via
     `__apply_closure` (the same native bridge #3140's bound-fn guard and the
     HOF arms use — see `NATIVE_HOF_METHODS`/`ensureNativeArrayHof` for the
     established per-element callback pattern).
- Array-like sources (`{length, 0: …}`) can reuse the `__extern_length` +
  `__extern_get_idx` walk (#2872's array-like construct arm is the template).
- Measure guide: `built-ins/TypedArray/prototype/fill` standalone was 46
  fail / 5 pass after PR #2881+#2884; the makeCtorArg tests fail at
  `assert #1` with the factory loop dying inside `makeArray`. Post-fix,
  expect the passthrough/array/arraylike factory combinations to execute —
  re-scan `built-ins/TypedArray/prototype` + `built-ins/Array/from`.

# Standalone: `fn.bind(...)` on a closure is not callable

## Problem

In `--target standalone`, `Function.prototype.bind` on a compiled closure
returns a value that is not a function:

```ts
function mk(TA: any, x: any) {
  return x;
}
export function test(): number {
  const f: any = mk;
  const bound = f.bind(undefined, 42);
  if (typeof bound !== "function") return 1; // ← returns 1 today
  const r = bound([5, 6]);
  return r.length === 2 && r[0] === 5 ? 9 : 3;
}
```

Compiles host-free, runs, returns `1` (expected `9`).

## Impact — the single biggest blocker for the modern TypedArray harness

test262's `testWithAllTypedArrayConstructors` (the CURRENT
`harness/testTypedArray.js`) drives every `testWithTypedArrayConstructors(f)`
test through per-factory bound functions:

```js
var boundArgFactory = argFactory.bind(undefined, constructor);
f(constructor, boundArgFactory);
```

so EVERY test using the `makeCtorArg` callback param (the majority of
`built-ins/TypedArray/prototype/**` content tests, ~hundreds of files) fails at
the harness level before the tested method even runs — regardless of how much
TA substrate exists (#2872 slice 1 landed general dynamic construction; these
tests still fail solely on `.bind`). Fixing `.bind` multiplies every TA
substrate slice already landed.

## Root cause (to verify)

`.bind` on an `any` receiver holding a native closure struct has no native
arm — it falls to the open-`$Object`/`__extern_method_call` path and returns
undefined/null. The reflective `.call`/`.apply` recovery landed in #2876/#3016
(`__apply_closure` + `emitReflectiveNativeProtoClosureCall`); `.bind` needs the
partial-application analog: allocate a wrapper closure carrying
`{target, boundThis, boundArgs($ObjVec)}` whose invoke path prepends
`boundArgs` and delegates through `__apply_closure`. `typeof` must answer
`"function"` for the wrapper (closure-classifier arm, see
`buildClosureRefTestArms` #3125).

## Acceptance criteria

- [ ] The repro above returns 9 (bound-arg prepend + passthrough, host-free).
- [ ] `typeof bound === "function"`.
- [ ] `bound.call(x, …)` / nested re-bind at least do not trap.
- [ ] Measured: `built-ins/TypedArray/prototype/fill/fill-values-relative-start.js`
      (and the makeCtorArg family) progress past the harness `bind` (they may
      still fail on later factory gaps — `.buffer` accessor, iterables).
- [ ] Zero host-mode regression (standalone/wasi-gated).
