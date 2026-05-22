---
id: 1382
sprint: 52
title: "structural: Wasm closures not JS-callable from host imports — bridge gap"
status: done
created: 2026-05-08
updated: 2026-05-20
completed: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: closures, callbacks
goal: ir-full-coverage
---
# #1382 — Wasm closures not JS-callable from host imports

## Problem

A recurring structural blocker across multiple features: Wasm closure structs
(`$closure_N`) cannot be passed directly as JS-callable function arguments to
host imports. This pattern is required by:

- **#1339** — `Array.from(items, mapFn)`: host `__array_from` receives a Wasm
  closure and errors "object is not a function"
- **#1358** — `Array.prototype.{filter,map,every,some,forEach}.call(obj, cb, thisArg)`:
  `__call_with_this(fn, thisArg, ...)` requires `fn` to be JS-callable, but Wasm
  closures aren't
- **#1338** — `Function.prototype.bind`: LHS coerce on the bound function fails
  because the JS bound function doesn't survive the `externref → closure struct`
  cast chain at the assignment site
- **#1371** (IR external call whitelist): any IR function passed as a callback
  to a whitelisted external hits the same wall

The root issue: our Wasm closures are `struct` refs — they're callable from
Wasm via `call_ref` using the function table, but the JS host receives an
opaque object with no `[[Call]]` internal method.

## Options

### Option A — JS-callable wrapper on demand (preferred)

Add a runtime primitive `__make_js_callable(closureRef, funcTableIdx) -> externref`
that wraps a Wasm closure in a JS `Function`:

```js
// src/runtime.ts
__make_js_callable(closure, funcIdx) {
  return function(...args) {
    return instance.exports.__wasm_call_closure(closure, funcIdx, ...args);
  };
}
```

The Wasm side exports `__wasm_call_closure(closure: externref, funcIdx: i32, ...args)`.
Call sites that need to pass a closure to a host import first call
`__make_js_callable`, store the result as `externref`, then pass it.

**Downside**: one allocation per callback site, plus the round-trip through JS.

### Option B — Always emit JS-callable trampolines for exported closures

When a closure is created and will be passed to a host import context (detectable
at compile time for typed call sites), emit a JS-function wrapper eagerly at
closure creation. Store alongside the `$closure_N` struct.

**Downside**: requires call-site type inference; harder to implement correctly.

### Option C — Thread thisArg as Wasm param, avoid host entirely

For `array.{filter,map,every,some,forEach}` specifically: the existing Wasm-native
loop already uses `call_ref` — it just needs `thisArg` threaded as an extra parameter
to the callback's function type. Change the closure function type signature to include
an optional `thisArg: externref` param and update call sites.

**Only solves the thisArg sub-problem, not Array.from mapFn or bind.**

## Recommended approach

Option A for the general case. Option C as a quick fix for `thisArg` in array
methods (since those are already Wasm-native loops and don't go through the host).

## Acceptance criteria

1. `Array.from([1,2,3], x => x * 2)` produces `[2,4,6]` — closure mapFn works.
2. `[1,2,3].map(fn, thisObj)` — thisArg is correctly forwarded to the closure.
3. `Function.prototype.bind` LHS: the bound result is assignable without triggering
   the closure-struct cast chain.
4. No performance regression on the existing `array.map` hot path (which uses
   `call_ref` directly and must NOT go through the JS wrapper).

## Files

- `src/runtime.ts` — `__make_js_callable` + `__wasm_call_closure` exports
- `src/codegen/array-methods.ts` — call sites for array callbacks
- `src/codegen/expressions/calls.ts` — bind call site coerce fix
- `src/ir/integration.ts` — IR external call whitelist bridge

## Notes

Discovered independently by dev-1306 during #1339, #1358 investigation.
Blocks: #1339 (mapFn), #1358 (thisArg), #1338 (bind LHS).

---

## Implementation Plan

### Root cause

A Wasm closure is a WasmGC struct (`$__fn_wrap_N_struct` / `$closure_N`) whose
field 0 is a funcref. When the value reaches JS via `extern.convert_any`, V8
sees an opaque externref with no `[[Call]]` internal method, so any host site
that tries to **invoke** it — `cb(...)`, `cb.apply(...)`, `Promise.then(cb)`,
`new Promise(executor)`, `Array.prototype.forEach.call(obj, cb)` — fails with
`callback is not a function` (or similar).

The infrastructure to bridge this already exists. We just don't use it at
the call sites that need it.

### Existing infrastructure (do NOT re-build)

| Piece | Where | What |
|---|---|---|
| `__call_fn_0` … `__call_fn_4` exports | `src/codegen/index.ts:994-1013`, generator `emitClosureCallExportN` at `src/codegen/index.ts:1876` | Generic N-arg WasmGC closure dispatchers. Take `(closure: externref, arg0: externref, …)` and return `externref`. Funcref-typed dispatch via `ref.test`/`ref.cast` on the lifted func-type. Emitted unconditionally (early-return when no closures of that arity exist). |
| `_wrapWasmClosure(closure, arity, callbackState)` | `src/runtime.ts:293-314` | Runtime helper. Returns a JS `Function` that pads/truncates JS args to exactly `arity` and dispatches via `__call_fn_<arity>`. Returns `null` if no matching `__call_fn_N` export exists. |
| `_isWasmStruct(val)` | `src/runtime.ts` (see `_isWasmStruct` definition earlier in file) | Probe — returns true for opaque WasmGC structs (catches the "WebAssembly objects are opaque" throw). |
| `wrapExports(rawExports)` | `src/runtime.ts:5047-5092` | Auto-wraps top-level exports so a user-visible export that returns a Wasm closure struct comes out as a JS function. (Already covers the user-facing surface but doesn't help when a closure is passed sideways into a host import as an argument.) |
| `__make_callback` / `__make_getter_callback` | `src/codegen/closures.ts:2584`, `src/runtime.ts:4529-4543` | Different mechanism: at compile time, lift arrow body into an exported `__cb_<id>` function and at the call site emit `__make_callback(id, captures)` so the host gets a JS function up front. This is *only* used when the codegen decides at compile time that the arrow is destined for a host callback slot. It does NOT help when an existing closure (e.g. a function-typed local) is passed to a host import. |

The one site that already wraps correctly: `__array_from` in `src/runtime.ts:3538-3547`. The wrapping pattern there is the template for every other site.

### Phase 1 — Wrap callback args inside JS-side host shims (low risk, high value)

For every host import that calls back into a JS-supplied callable, detect a
Wasm-closure arg via `_isWasmStruct` and route it through `_wrapWasmClosure`
*before* handing it to the native engine. This is a pure runtime change — no
codegen, no new exports, no Wasm-side work.

**File: `src/runtime.ts`**

#### Step 1.1 — Add a thin convenience helper near `_wrapWasmClosure` (~line 314)

```ts
/**
 * (#1382) If `val` is an opaque WasmGC closure struct, return a JS Function
 * wrapping it via `_wrapWasmClosure(val, arity)`. Otherwise return `val`
 * unchanged (real JS function, undefined, null — caller handles).
 *
 * The returned wrapper is fresh per call; do NOT use as a stable identity
 * key (`p.then(cb1) === p.then(cb1)` is not preserved, matching how
 * `__array_from` already behaves).
 */
function _maybeWrapCallable(
  val: any,
  arity: number,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (val == null) return val;
  if (typeof val === "function") return val;
  if (!_isWasmStruct(val)) return val;
  const wrapped = _wrapWasmClosure(val, arity, callbackState);
  return wrapped ?? val;
}
```

#### Step 1.2 — Wrap callbacks in `Promise_*` host imports (`src/runtime.ts:3903-3909`)

```ts
if (name === "Promise_resolve") return (val: any) => Promise.resolve(val);  // unchanged — val is a value, not a callback
if (name === "Promise_reject")  return (val: any) => Promise.reject(val);   // unchanged
// `executor` is called as `executor(resolve, reject)` — arity 2.
if (name === "Promise_new")
  return (executor: any) => new Promise(_maybeWrapCallable(executor, 2, callbackState));
// `onFulfilled` / `onRejected` are arity-1 callbacks (the resolved value or reason).
if (name === "Promise_then")
  return (p: any, cb: any) =>
    p.then(_maybeWrapCallable(cb, 1, callbackState));
if (name === "Promise_then2")
  return (p: any, cb1: any, cb2: any) =>
    p.then(_maybeWrapCallable(cb1, 1, callbackState), _maybeWrapCallable(cb2, 1, callbackState));
if (name === "Promise_catch")
  return (p: any, cb: any) =>
    p.catch(_maybeWrapCallable(cb, 1, callbackState));
// `onFinally` is arity-0 (no arg per spec §27.2.5.3).
if (name === "Promise_finally")
  return (p: any, cb: any) =>
    p.finally(_maybeWrapCallable(cb, 0, callbackState));
```

#### Step 1.3 — Wrap callback args in `__proto_method_call` (`src/runtime.ts:3432-3478`)

This is the high-value site: `Array.prototype.forEach.call(obj, cb, thisArg)`,
`Array.prototype.map.call(obj, cb)`, `Array.prototype.reduce.call(obj, cb, init)`,
`Array.prototype.sort.call(obj, comparator)`, etc. all funnel through here. The
current code only `_wrapForHost`s args for property enumeration; it never
wraps closures into callables.

Approach: a per-method callback-slot table. Look up `methodName` to learn (a)
the **arg index** that holds the callback, and (b) the **arity** at which V8
will invoke it. Anything not in the table is passed through unchanged (current
behaviour).

```ts
// (#1382) Methods that receive a callback as an argument. Maps
// `methodName -> { argIdx, arity }` so we can pre-wrap a Wasm-closure
// arg into a JS Function before the native engine invokes it.
// - argIdx is the 0-based position in the args array.
// - arity matches the spec: how many positional args V8 will pass.
//   Extra args are dropped by `_wrapWasmClosure`'s padding logic.
const _PROTO_CB_SLOTS: Record<string, { argIdx: number; arity: number }> = {
  // Array.prototype — callback at args[0], invoked as (value, index, array)
  forEach:    { argIdx: 0, arity: 3 },
  map:        { argIdx: 0, arity: 3 },
  filter:     { argIdx: 0, arity: 3 },
  find:       { argIdx: 0, arity: 3 },
  findIndex:  { argIdx: 0, arity: 3 },
  findLast:   { argIdx: 0, arity: 3 },
  findLastIndex: { argIdx: 0, arity: 3 },
  every:      { argIdx: 0, arity: 3 },
  some:       { argIdx: 0, arity: 3 },
  flatMap:    { argIdx: 0, arity: 3 },
  // reduce/reduceRight: callback at args[0], invoked as (acc, value, index, array)
  reduce:      { argIdx: 0, arity: 4 },
  reduceRight: { argIdx: 0, arity: 4 },
  // sort: comparator at args[0], invoked as (a, b)
  sort:       { argIdx: 0, arity: 2 },
  // String.prototype.replace(pattern, replacement) — replacement may be a fn
  // invoked as (match, ...captureGroups, offset, string, groups?). Spec arity
  // is variable; use 4 as a sensible cap (match, offset, string + 1 capture).
  // This is intentionally a best-effort cap; full variadic support is Phase 2.
  replace:    { argIdx: 1, arity: 4 },
  replaceAll: { argIdx: 1, arity: 4 },
  // TypedArray.prototype.* uses identical callback signatures to Array,
  // and __proto_method_call dispatches them via typeName === "Array" /
  // "Int8Array" / etc., so they pick up the entries above naturally.
};

if (name === "__proto_method_call")
  return (typeName: string, methodName: string, receiver: any, args: any[]) => {
    // …existing wrappedReceiver / wrappedArgs setup unchanged up to line 3475…

    // (#1382) Replace a Wasm-closure callback arg with a JS-callable wrapper
    // BEFORE dispatching into V8. Without this, V8 throws "callback is not a
    // function" when invoking the closure. Wrap on `wrappedArgs` so the
    // _wrapForHost proxy logic above already ran for other args.
    const slot = _PROTO_CB_SLOTS[methodName];
    if (slot && wrappedArgs.length > slot.argIdx) {
      const cb = wrappedArgs[slot.argIdx];
      wrappedArgs[slot.argIdx] = _maybeWrapCallable(cb, slot.arity, callbackState);
    }

    // …existing sparse-fast-path block and `method.call(...)` dispatch unchanged…
  };
```

#### Step 1.4 — Wrap callback args in `__extern_method_call` (`src/runtime.ts:3328-3428`)

Same idea, same `_PROTO_CB_SLOTS` table:

```ts
if (name === "__extern_method_call")
  return (obj: any, method: string, args: any[]) => {
    // …existing wrappedObj / wrappedArgs setup unchanged…

    // (#1382) Wrap a Wasm-closure callback arg into a JS Function before
    // V8 dispatches. Looks up the same slot table as __proto_method_call.
    const slot = _PROTO_CB_SLOTS[method];
    if (slot && wrappedArgs.length > slot.argIdx) {
      const cb = wrappedArgs[slot.argIdx];
      wrappedArgs[slot.argIdx] = _maybeWrapCallable(cb, slot.arity, callbackState);
    }

    const fn = wrappedObj[method];
    // …existing fall-through (Map/WeakMap upsert, DataView, throw)…
    const ret = fn.apply(wrappedObj, wrappedArgs);
    return ret === wrappedObj ? obj : _unwrapForHost(ret);
  };
```

#### Step 1.5 — Audit other host imports that take callable args

These need the same wrap once Phase 1 is verified working for the big four:

| Host import | File / line | Callback slot | Arity |
|---|---|---|---|
| `__array_from` | `src/runtime.ts:3538` | `mapFn` (arg 1) | 2 | **already done — template** |
| `__object_groupBy` | `src/runtime.ts:3513` | `keyFn` (arg 1) | 1 | needed |
| `__defineProperty_accessor` | `src/runtime.ts:2974` | `get` (arg 2), `set` (arg 3) | 0 / 1 | needed (descriptor accessors) |
| `__object_fromEntries` | `src/runtime.ts:3508` | iterable elements may be wasm vec — already covered by `_materializeIterable` indirectly; **no change** |

The `__defineProperty_accessor` wrap is subtle: the descriptor object passed
to `Object.defineProperty` must end up with `get`/`set` that have correct
`this`-binding. The existing `__make_getter_callback` path (`src/runtime.ts:4535`)
handles arrow functions emitted at compile time; for Wasm closure structs
arriving here we need:

```ts
if (_isWasmStruct(getVal)) descriptor.get = _wrapWasmClosure(getVal, 0, callbackState) ?? getVal;
if (_isWasmStruct(setVal)) descriptor.set = _wrapWasmClosure(setVal, 1, callbackState) ?? setVal;
```

Note `_wrapWasmClosure`'s wrapper signature is `function wasmClosureBridge(this, ...args)`
which **drops** `this` because `__call_fn_<arity>` doesn't take it. For accessors
that close over `this`, that's a known follow-up (#1382 P3 below).

### Phase 2 — `thisArg` forwarding through `__proto_method_call`

`Array.prototype.forEach.call(obj, cb, thisArg)` — V8 invokes `cb.call(thisArg, item, idx, arr)`.
Our wrapper from `_wrapWasmClosure` ignores `this`, so `thisArg` is silently
dropped. Spec-correctness needs `thisArg` threaded into the closure.

Two options:

1. **Wasm-side**: extend each `__call_fn_<arity>` to accept an optional
   `thisArg: externref` *first* user arg, and codegen the closure body to
   read it from `arguments[-1]` or a dedicated synthetic param. **Hard**:
   requires re-shaping every closure's lifted-func signature.

2. **JS-side at the wrapper**: detect that the closure body uses `this`
   *at compile time*, and emit a paired `__call_fn_<arity>_with_this`
   export that takes `(closure, thisArg, …args)`. Then `_wrapWasmClosure`
   uses `function (this, ...args)` to forward `this` through the new export.

Recommend **deferring Phase 2 to a follow-up issue** — it requires
codegen work and isn't needed for the immediate test262 wins. The acceptance
criterion "thisArg correctly forwarded" can be marked partially met.

### Phase 3 — `Function.prototype.bind` LHS coercion fix (#1338)

Separate problem: `let bound: () => void = fn.bind(thisArg)`. The RHS produces
an externref (JS bound function); the LHS type forces a `ref.cast` to
`$closure_N`, which traps at runtime because a JS function is not a Wasm
closure struct.

**Defer to a dedicated follow-up issue.** Fix outline (for the eventual spec):
- At the assignment-target coercion in `src/codegen/type-coercion.ts`, when
  the source is externref and the target is `(ref $__fn_wrap_N_struct)`,
  do NOT emit `ref.cast`. Instead, synthesize a forwarder closure: allocate
  a fresh `$__fn_wrap_N_struct` whose funcref points to an emitted shim
  that takes `(self, …args) → result` and calls a new host import
  `__call_extern_N(self.boundExtern, …args) → result`. The shim reads the
  externref out of a sidecar field on the closure struct.
- This requires a new closure-struct shape variant (the funcref shim plus
  an externref sidecar field), which is a non-trivial codegen change.

### Phase 4 — IR external-call whitelist (#1371)

When an IR function is passed as a callback to a whitelisted external
(`Math.*`, `parseInt`, …), the same wrap applies. **No new mechanism needed:**
once Phase 1 lands, IR external calls go through `__extern_method_call`
or a dedicated host import; the wrap-on-entry pattern from Step 1.4 covers it.
Make sure the IR integration path uses one of the already-wrapped imports
(`__extern_method_call`, `__proto_method_call`) rather than emitting a fresh
JS-host shim that bypasses the wrap.

### Wasm signatures (no codegen changes required for Phase 1)

The existing `__call_fn_N` signature is sufficient:

```wasm
(func $__call_fn_3
  (param $closure externref)
  (param $a0 externref)
  (param $a1 externref)
  (param $a2 externref)
  (result externref))
```

For closures whose declared param types are `f64`/`i32`, the dispatcher unboxes
via `__unbox_number` (see `src/codegen/index.ts:1979-1996`). Return values are
boxed back via `__box_number` to externref. **No changes needed** — both paths
already work and are exercised by `__array_from`'s mapFn.

### Edge cases (must be tested)

1. **Callback is a real JS function** (e.g. host-imported `Math.sin` passed
   as a comparator): `_isWasmStruct` returns false, `_maybeWrapCallable`
   returns the JS function unchanged. **No regression.**
2. **Callback is `null`/`undefined`**: `_maybeWrapCallable` returns the
   value unchanged. V8 then throws the spec-correct `TypeError: x is not
   a function`, matching native behavior.
3. **Closure of arity ≠ slot arity** (e.g. a 1-arg arrow passed to forEach
   which expects 3-arg cb): `_wrapWasmClosure` looks up `__call_fn_3`, but
   the closure was lifted with `__call_fn_1` semantics. Dispatch still works
   because `emitClosureCallExportN` iterates ALL closure shapes with
   `paramTypes.length ≤ N` and the matching arm only pushes
   `closureArity` user args (see `src/codegen/index.ts:1908`). Extra JS
   args dropped at the wrapper layer (line 311 — `for (i = 0; i < arity)`).
4. **Closure that returns void**: `__call_fn_N` returns `externref` with
   `ref.null.extern` for void closures. JS sees `undefined`. Correct for
   forEach (return ignored), filter (falsy → drop), every (falsy → false).
5. **Re-entrancy**: closure callback invokes another host method that itself
   takes a closure callback. `_wrapWasmClosure` is re-entrant safe (no
   shared mutable state; each call captures its own `closure` ref).
6. **Returning a Wasm closure from the JS-wrapped callback**: e.g. `arr.map(x => () => x)`.
   The wrapper returns externref containing a Wasm closure struct. The next host
   site that consumes it must also be wrapped. Already covered for chained
   array methods because the result flows back through `__proto_method_call`
   on the next `.map(...)`.
7. **Sort comparator return value**: spec says JS sort coerces return to
   number. Our closure may return f64 (boxed via `__box_number` → externref
   Number wrapper) or i32 (same path). V8's sort calls `ToNumber()` on the
   result; both paths work.
8. **Throwing closure**: throws inside `__call_fn_<arity>` propagate as Wasm
   exceptions which surface in JS as JS errors (via the standard exn tag
   bridge); native `Array.prototype.forEach` is exception-transparent so the
   throw bubbles back out to Wasm. Already exercised by #1358 fixtures.

### Files to touch (Phase 1 only)

- `src/runtime.ts`
  - Add `_maybeWrapCallable` helper near `_wrapWasmClosure` (~line 315).
  - Add `_PROTO_CB_SLOTS` table near `_PROTO_METHOD_CALL` (~line 3430).
  - Wrap callbacks in `Promise_new` / `Promise_then` / `Promise_then2` /
    `Promise_catch` / `Promise_finally` (lines 3905-3909).
  - Wrap callbacks in `__proto_method_call` (~line 3475, before
    `method.call(...)`).
  - Wrap callbacks in `__extern_method_call` (~line 3426, before
    `fn.apply(...)`).
  - Wrap descriptor accessors in `__defineProperty_accessor` (~line 2974).
  - Wrap `keyFn` in `__object_groupBy` (~line 3513).
- **No changes** to `src/codegen/*` — Phase 1 is runtime-only.

### Test fixtures

Phase 1 should be validated by running test262 against the following buckets
(currently failing with `callback is not a function` / `TypeError: cb is not
a function`):

- `test/built-ins/Array/from/iter-set-elements.js` (mapFn — already works
  for vec receivers, exercise plain-iterable receivers too)
- `test/built-ins/Promise/prototype/then/*` — at least 20 tests fail with
  Wasm-closure callbacks (estimated from #1338/#1339/#1358 patterns)
- `test/built-ins/Promise/prototype/catch/*`
- `test/built-ins/Promise/prototype/finally/*`
- `test/built-ins/Promise/promise-resolve-function-not-callable.js`
  (and the `…not-callable` reject-side equivalents — should now correctly
  throw because our wrapper preserves the non-function case)
- `test/built-ins/Array/prototype/{filter,map,every,some,forEach,reduce}/cb-arguments-*.js`
  (these test that V8 passes `(value, index, array)` and the wasm closure
  receives them correctly — should pass once Phase 1 lands)

### Estimated test262 gain (Phase 1 only)

Coarse upper bound from the original issue text and #1358's "452 assertion_fail":

- `__proto_method_call` callback wrap: **up to ~100-200 tests** previously
  failing because the host couldn't invoke the closure. The bigger #1358
  bucket has already been redirected to the Wasm-native loop in
  `compileArrayLikePrototypeCall`, but the residual fallback cases
  (assert.throws-wrapped tests, primitive receivers, struct receivers with
  `__sget_*` getters) still funnel through `__proto_method_call`.
- Promise.* callback wrap: **up to ~50-80 tests** in
  `test/built-ins/Promise/prototype/{then,catch,finally}/*`. Most current
  Promise instance-method failures resolve to "executor is not a function"
  or "onFulfilled is not a function".
- `__array_from` mapFn (already done): **~10-20 tests** already counted in
  baseline.
- Function.prototype.bind LHS (Phase 3): **~20-40 tests** (#1338) — NOT in
  this issue's scope.

**Net expected gain from Phase 1: ~150-280 tests.** Verify against
`benchmarks/results/test262-current.jsonl` post-merge for the actual count.

### Risk surface

1. **Identity-of-callback observable**: any test that checks
   `cb === passedCb` after a host roundtrip will break, because the wrapper
   is a fresh JS function per call. This is already the case for
   `__array_from`'s mapFn since the original wrap landed; no new regression
   expected, but watch for it in `test262-baseline-validate` sampling.
2. **Wrapper identity not preserved across two `.then()` invocations**:
   `p.then(cb).then(cb)` allocates two distinct wrappers. Benign in spec
   terms (promise chaining doesn't observe callback identity), but
   measurable allocation overhead on Promise-heavy tests. Acceptable.
3. **Closure dispatcher arity mismatch**: confirmed safe — see Edge Case 3.
   But: if a higher arity (5+) callback is ever needed (e.g. some host
   variadic), there's no `__call_fn_5` export yet and `_wrapWasmClosure`
   would return null, defaulting to the unchanged closure and re-introducing
   the original error. Add `__call_fn_5` in `src/codegen/index.ts` (one line:
   `emitClosureCallExportN(ctx, 5)` next to existing 3/4) if any callback
   site needs it.
4. **Performance**: each wrapped call adds one JS closure allocation + one
   variadic spread. Negligible for test262 but watch
   `playground-benchmark-sidebar.json` on the dev-self-merge diff. If a hot
   path regresses, the closure check (`_isWasmStruct`) can be cheapened to
   a `typeof !== "function"` guard with the `_isWasmStruct` only on the
   slow path.

### Out of scope for this issue

- Phase 3 (bind LHS coercion) — split into a separate issue, blocked-by #1382.
- Phase 4 (IR external-call whitelist) — falls out for free once Phase 1
  lands; track in #1371 with a one-line follow-up to route through
  `__extern_method_call` rather than emitting a bespoke import.
- `this`-binding in wrapped closures (forEach `thisArg`, accessor descriptors).
  Tracked as Phase 2 / follow-up.

## Suspended Work

- **PR**: https://github.com/loopdive/js2/pull/409
- **Branch**: `issue-1382-wasm-closures-bridge`
- **Worktree**: `/workspace/.claude/worktrees/issue-1382-wasm-closures-bridge/`
- **HEAD SHA**: `ab5fe2d4ef25487985ebaa7b160c6cc39a6919c0`
- **State**: ci-wait
- **Done (Phase 1)**:
  - `_maybeWrapCallable(val, arity, callbackState)` helper in `src/runtime.ts`
  - `_PROTO_CB_SLOTS` table mapping method name → `{argIdx, arity}` for callback-taking prototype methods
  - Wired at: `Promise_new` / `Promise_then` / `Promise_then2` / `Promise_catch` / `Promise_finally`, `__proto_method_call`, `__extern_method_call`, `__defineProperty_accessor`, `__object_groupBy`, `getOrInsertComputed` (via slot table)
  - `tests/issue-1382.test.ts` — 7/7 passing locally
- **Remaining (deferred to follow-up issues per spec)**:
  - Phase 2: `thisArg` forwarding through wrapped accessors (requires Wasm-side closure-signature work)
  - Phase 3: `Function.prototype.bind` LHS coercion (#1338)
  - Phase 4: IR external-call whitelist (#1371) — falls out for free once Phase 1 lands
- **Resume**: when ci-status JSON arrives at `/workspace/.claude/ci-status/pr-409.json` with matching SHA, run `/dev-self-merge 409`.
