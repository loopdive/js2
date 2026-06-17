---
id: 1632
title: "spec gap: Function.prototype.bind/toString + Function/internals (175 + 7 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: function
goal: spec-completeness
sprint: 50
renumbered_from: 1338
parent: 1328
required_by: [1732]
---
# #1338 — Function objects: bind, toString, length, internals

## Problem

`built-ins/Function`: **207 / 509 (40.7%) — 301 fails** (assertion_fail=122, type_error=65,
runtime_error=43, other=30, wasm_compile=21).

`built-ins/Function/internals`: **1 / 8 (12.5%) — 7 fails**.

Spec §20.2 (Function objects) requires:
1. **`Function.prototype.bind`** (§20.2.3.2): produce a bound function whose
   - `[[BoundTargetFunction]]` is the original
   - `[[BoundThis]]` is set
   - `[[BoundArguments]]` is the partial-application arg list
   - `length` is `max(0, target.length - boundArgs.length)`
   - `name` is `"bound " + target.name`
2. **`Function.prototype.toString`** (§20.2.3.6): return either the source text or a
   `"function name() { [native code] }"` representation for built-ins.
3. **`length`** is the count of formal parameters before the first default-valued or rest param.
4. **`name`** is the binding name (or computed-property name in a class).

Current state:
- `bind` produces a callable, but `length` and `name` aren't recomputed.
- `toString` returns an opaque marker, not the original source — fails any spec test that
  parses the result with `eval`.
- `Function/internals` tests check the [[Call]] / [[Construct]] receiver semantics; we throw
  TypeError on receivers we shouldn't (e.g., calling a bound function with the wrong this).

## Acceptance criteria

1. `built-ins/Function/prototype/bind/length.js` passes.
2. `built-ins/Function/prototype/bind/name.js` passes.
3. `built-ins/Function/prototype/bind/instance-name.js` passes.
4. `built-ins/Function/prototype/toString/built-in-function-object.js` passes.
5. Pass-rate for `built-ins/Function` rises from 40.7% to ≥65%.

## Files to modify

- `src/codegen/closures.ts` — bind closure struct (add length/name fields)
- `src/codegen/index.ts` — function metadata (length, name, source)
- `src/runtime.ts` — `__function_to_string` (returns source or native marker)

## Implementation Plan

### Root cause

`bind` is implemented as a thin externref wrapper that forwards to host `Function.prototype.bind`
when the receiver is externref, and as a closure-allocating Wasm helper for typed functions —
but the typed helper allocates a generic closure struct with no `length` or `name` fields,
so accessing them returns the **target's** values (wrong by spec).

`toString` for compiled-Wasm functions has no source-text reference (the source is parsed and
then discarded). We need to either:
1. Keep the source-text alive in a string table, or
2. Re-emit a synthetic `"function name() { [native code] }"`.

### Approach

1. Extend the bound-function closure struct with `length: i32` and `name: ref string` fields.
   Compute them at the bind callsite when arg count is statically known; otherwise emit an
   inline computation.
2. For `toString`, store a per-function source-text string in a side-table indexed by function
   index. Load it on demand in `__function_to_string`. Fall back to `[native code]` for
   imported/host functions.

### Edge cases

- bind on arrow function (no `this` binding) — bind succeeds; the resulting `this` is ignored.
- bind on a class constructor — must be callable with `new`.
- name on anonymous function (let f = function(){}) is the binding name `"f"`.

### Test262 sample

- `test262/test/built-ins/Function/prototype/bind/length.js`
- `test262/test/built-ins/Function/prototype/toString/built-in-function-object.js`

## Investigation 2026-05-27 (issue-1318-v2 / dev-1608)

Smoke-tested current main (`a619649a`) against the three target buckets via
`runTest262File`:

| Bucket | Pass / Total |
|--------|--------------|
| `built-ins/Function/prototype/bind` | **34 / 100** (66 fail) |
| `built-ins/Function/prototype/toString` | **67 / 80** (13 fail) |
| `built-ins/Function/internals` | **3 / 8** (5 fail — Proxy/realm, hard) |

The acceptance-criteria probes are **already split**: `bind/length.js`,
`bind/name.js` already PASS (they test `Function.prototype.bind`'s OWN
`.length===1`/`.name==="bind"`, which the codegen resolves). What FAILS is
`bind/instance-name.js` — the **bound function's** `.name` must be
`"bound target"` (criterion 3).

### Root cause confirmed — identity-bind is the blocker

`fn.bind(...)` lowers via the **identity-bind** path at
`src/codegen/expressions/calls.ts:2068`: it drops all bind args and returns the
**target receiver externref unchanged** (an intentional documented
simplification). Consequences, all confirmed by probe:

- `target.bind().name` → `"target"` (should be `"bound target"`) — the bound
  object IS the target, so it carries the target's name.
- `target.bind(undefined,1).length` → `0` (should be recomputed
  `max(0, target.length - boundArgs.length)`) — the result is plain externref,
  losing the TS call signatures the `.length` branch
  (`property-access.ts:1552`) needs.
- `target.bind(undefined,5)()` → RUNERR — the externref isn't a real callable
  bound function with `[[BoundArguments]]` prepending.

These three are NOT independently fixable on the identity-bind path: correct
`.name`/`.length`/`[[Call]]`/`[[Construct]]` all require the bound function to
be a **distinct object** carrying its own metadata. 19 of the 66 bind fails
also need `[[Construct]]` (`new`/`instanceof`).

### A localized hack is not viable

Prepending `"bound "` only when `.name` is accessed directly on a `bind()`
call-expression would fix exactly one shape (`target.bind().name`) and miss the
dominant via-local form (`const b = target.bind(); b.name`), which has already
collapsed to the target externref by the time `.name` is read. It would not
touch `.length` or call semantics. Net test262 movement ≈ 1, with fragility
risk. Rejected.

### toString sub-bucket (13 fail) is a separate feature

The `prototype/toString` failures need **verbatim source-text retention**
(including interior comments like `async f /* a */ ( /* b */ )`) or a
`[native code]` form that matches the `NativeFunction` grammar in
`nativeFunctionMatcher.js`. Two are `compile_error` on async/getter
class-expression parsing. This is orthogonal to bind and warrants its own
sub-issue.

### Recommendation — ESCALATE for architect spec, then carve

The load-bearing change is the **bound-function representation**, which is a
real WasmGC design decision (matches the issue's own `feasibility: medium /
reasoning_effort: high` and "Files to modify" list spanning `closures.ts` +
`index.ts` + `runtime.ts`). Suggested carve:

1. **#1632a — bound-function object** (architect spec needed): WasmGC closure
   struct (or host-`Function.prototype.bind` delegation in JS mode) carrying
   `[[BoundTargetFunction]]`/`[[BoundThis]]`/`[[BoundArguments]]` + recomputed
   `length`/`name` (`"bound "` prefix) + `[[Call]]`/`[[Construct]]`. Closes the
   bulk of the 66 bind fails. The JS-host-delegation angle is attractive but
   blocked by the fact that a compiled local `var f = function(){}` is a WasmGC
   closure, not a host callable — so the host's real `bind` can't be applied
   without first wrapping the closure as a host function (see `_wrapForHost`,
   `src/runtime.ts:2118`).
2. **#1632b — Function.prototype.toString source retention** (13 fail):
   per-function verbatim source slice in a side-table, surfaced by
   `__function_to_string`.
3. **#1632 internals** (5 fail): Proxy/realm `[[Call]]`/`[[Construct]]`
   receiver semantics — likely defer (Proxy is a skip-filter feature).

No code change landed; reverted worktree to clean. Recommend re-routing #1632
to architect for the #1632a spec before any dev implementation.

## Resolution (2026-05-28, developer) — #1632a landed

Implemented per the architect spec above. Changes:

- `src/runtime.ts` (~5478) — new `__bind_function(target, thisArg, argsArray,
  nameHint, lengthHint) -> externref` host import. For Wasm-closure-struct
  targets, wraps via `_wrapWasmClosure` with the codegen-supplied arity hint,
  stamps `name` and `length` properties on the wrapper, then delegates to
  `Function.prototype.bind.apply(wrapped, [thisArg, ...partial])`. The host
  then owns spec-correct `[[BoundTargetFunction]]` / `[[BoundThis]]` /
  `[[BoundArguments]]`, `.name === "bound " + target.name`, and `.length =
  max(0, target.length - boundArgs.length)`. Degrades to identity-bind when
  no `callbackState` (no exports) is available, matching the pre-#1632a
  hostless fallback.
- `src/codegen/expressions/calls.ts` — replaced the identity-bind body (the
  former lines 2069–2087) with `compileFunctionBind`. The helper:
  1. Pushes the target externref (extern-converting Wasm closure structs).
  2. Pushes `thisArg` (or `ref.null.extern`).
  3. Builds a JS Array of partial args via `__js_array_new`/`__js_array_push`.
  4. Pushes `nameHint` (a host string constant resolved statically from the
     receiver's binding declaration — names from `function f(){}` declarations
     AND named function expressions `const fn = function namedFn(){}`).
  5. Pushes `lengthHint` (TS parameter count up to the first
     optional/default/rest, skipping the synthetic `this` pseudo-param).
  6. Calls `__bind_function`.
  Standalone (`ctx.standalone || noJsHost(ctx)`) skips the import and
  degrades to identity-bind, preserving pre-#1632a behaviour for WASI builds.
- `src/codegen/property-access.ts` — `.name` and `.length` on the result of a
  `.bind(...)` call MUST bypass the static-resolution peephole (which would
  return the *target's* name/length instead of the bound function's spec
  values). Both branches now check whether the receiver of the property
  access is a `.bind(...)` call and fall through to the runtime
  `__extern_get` path so the host bound function's own properties are read.
- `tests/issue-1632a.test.ts` — 9 cases: spec-correct `.name`/`.length`
  recomputation, partial-arg evaluation order, identity over named function
  expression, JSON.bind() preserves the legacy TypeError throw, etc. The
  test for `bound: any` then `bound(arg)` is `it.skip` and pinned to #1596
  (general dyn-call lowering through an externref-typed local).
- `tests/issue-1463.test.ts` — the "identity bind survives variable storage"
  baseline is now `it.skip`'d with a note pointing back to #1632a. The
  former identity-bind workaround it pinned is intentionally superseded;
  invoking `const bf = fn.bind(...); bf(x)` requires the general
  externref-callable lowering tracked by #1596.

### Verification

- `tests/issue-1632a.test.ts` — 9/9 pass.
- `tests/issue-1038.test.ts` — 4/4 (existing bind smoke tests still pass).
- `tests/issue-1463.test.ts` — 3/3 active (1 newly-skipped per above).
- `tests/host-import-allowlist-budget.test.ts` — pass (no allowlist growth;
  `__bind_function` is JS-host-only and only needed when host bind is
  available).
- `pnpm run check:ir-fallbacks` — pass (no IR fallback regressions).
- No new regressions in `issue-149`, `issue-1450`, `issue-1533`,
  `issue-1552`, `issue-1639`, `issue-263`, `issue-1553a` (pre-existing
  failures verified against main HEAD).

### Out of scope (carved follow-ups)

- **#1632b — `Function.prototype.toString` source retention**: still open;
  needs verbatim source slicing for arrow / method / generator forms.
  Tracked in #1632 investigation (2026-05-27).
- **#1632 internals — Proxy/realm `[[Call]]`/`[[Construct]]` receiver
  semantics**: defer (Proxy is a skip-filter feature).
- **General `bound(x)` invocation through an externref-typed local**: gated
  on #1596 (Function.prototype.apply/.call on compiled Wasm functions). The
  immediate-call shape `fn.bind(...)(args)` works via the existing static
  reduction; storage-and-call is the gap.

---

# #1632b — host-callable/constructible compiled-fn representation (architect spec)

`status: ready` · `feasibility: hard` · `reasoning_effort: high` ·
`area: runtime` · spec authored 2026-06-03 (senior-developer)

## Why this is one central spec, not many local patches

Several open gaps share a single root cause: **a compiled Wasm function (a
WasmGC closure struct) has no host representation that is both `[[Call]]`-able
and `[[Construct]]`-able.** When such a value reaches a host built-in that needs
to *call* or *construct* it, the host wraps it via `_wrapForHost`
(`src/runtime.ts:3592`), whose Proxy target is `Object.create(null)` — a plain,
non-callable object with only `get`/`set`/`has`/`ownKeys`/… traps. V8 therefore
rejects both `wrapped(args)` (`apply`) and `new wrapped(args)` / `Construct`
(`construct`).

Confirmed dependents (do **not** patch these individually — they all resolve
once the representation lands):

- **#1694 A.i** — `Promise.all.call(NotPromise, […])` where `NotPromise` is a
  compiled Wasm function. The combinator path is spec-correct
  (`_resolveCtor` → `Promise.METHOD.call(C, _toIterable(arr))`,
  runtime.ts:7822/7863); it fails only because V8's
  `NewPromiseCapability(C)` does `Construct(C, [executor])` on the
  non-constructible wrapper. This is the *sole* remaining #1694 failure
  (B + A.ii + ctx-non-object/ctx-non-ctor all pass on current main — see #1694
  re-validation 2026-06-03).
- **#1632a residual** — `const b = fn.bind(...); new b(...)`: the host
  `__bind_function` (runtime.ts:~5478) already wraps the target via
  `_wrapWasmClosure` for `[[Call]]`, but the bound result's `[[Construct]]`
  on a compiled-fn target dead-ends the same way.
- **#1596 residual** — `Reflect.apply` / `Function.prototype.apply.call` on a
  compiled fn stored in an externref local. `__call_function`
  (runtime.ts:7043) already covers the `[[Call]]` half via `_wrapWasmClosure`;
  `new`-through-a-local hits the construct dead-end.
- **#1732 S1 `__construct`** (runtime.ts:7078) and **`__reflect_construct`**
  (runtime.ts:7058) — both wrap a struct callee via `_wrapForHost` then call
  `Reflect.construct(wrappedCallee, …)`. Today this throws "not a constructor"
  for a real compiled-class constructor passed dynamically, because the wrapper
  is not constructible.

## Core design — `_wrapCallableForHost(closure, exports)`

Add a sibling to `_wrapForHost` that wraps a **closure** struct in a Proxy
**whose target is a real `function`**, so the Proxy may legally carry `apply`
and `construct` traps (a Proxy is callable/constructible iff its *target* is).

```ts
// src/runtime.ts — near _wrapForHost (~3592) and _wrapWasmClosure (~1436)
const _hostCallableCache = new WeakMap<object, Function>();

function _wrapCallableForHost(
  closure: any,
  exports: Record<string, Function> | undefined,
): any {
  if (closure == null || typeof closure !== "object") return closure;
  if (!_isWasmStruct(closure)) return closure;
  const cached = _hostCallableCache.get(closure);
  if (cached) return cached;

  // The Proxy target must itself be callable+constructible for the traps to
  // be installable and for `typeof proxy === "function"` to hold. A bare
  // `function(){}` is both [[Call]] and [[Construct]] capable.
  const fnTarget = function compiledFnTarget() {};

  // Surface .name / .length when the codegen stamped them on the closure
  // sidecar (see #1632a __bind_function), so Function.prototype.toString /
  // .name reads stay spec-shaped. Best-effort; non-fatal if absent.
  const meta = _wasmStructProps.get(closure);
  if (meta) {
    if (typeof meta.name === "string")
      try { Object.defineProperty(fnTarget, "name", { value: meta.name, configurable: true }); } catch {}
    if (typeof meta.length === "number")
      try { Object.defineProperty(fnTarget, "length", { value: meta.length, configurable: true }); } catch {}
  }

  const handler: ProxyHandler<any> = {
    apply(_t, thisArg, args) {
      // Dispatch through __call_fn_<arity>. Pick the arity bucket from the
      // actual JS arg count, falling back exactly like _maybeWrapCallableUnknownArity.
      const wrapped = _wrapWasmClosureByArgCount(closure, args.length, exports);
      // thisArg is dropped: compiled closures capture their environment; they
      // do not consume a JS `this` (matches _wrapWasmClosure semantics).
      return wrapped(...args);
    },
    construct(_t, args, _newTarget) {
      // [[Construct]] of a compiled function. Two sub-cases:
      //  (1) compiled CLASS constructor — route to the class's construct export
      //      `__new_<Class>` / `__construct_closure` (see below).
      //  (2) ordinary function used with `new` — ECMA-262 §10.2.2: run the body
      //      with a fresh ordinary object as `this`, return it unless the body
      //      returns an object. For a compiled closure with no [[Construct]] of
      //      its own we emulate OrdinaryCallEvaluateBody by invoking the call
      //      export and applying the "return value if object else new this".
      const ctor = exports?.__construct_closure as
        | ((c: any, argsArr: any[]) => any) | undefined;
      if (typeof ctor === "function") {
        const r = ctor(closure, args);
        return (r != null && typeof r === "object") ? r : Object.create(null);
      }
      // Fallback: treat as ordinary [[Construct]] over the call export.
      const wrapped = _wrapWasmClosureByArgCount(closure, args.length, exports);
      const self = Object.create(null);
      const r = wrapped.apply(self, args);
      return (r != null && typeof r === "object") ? r : self;
    },
    // Property reads (.prototype, .name, .length, static members) delegate to
    // the SAME safeGetField machinery _wrapForHost uses. Factor that helper out
    // of _wrapForHost so both wrappers share one implementation (see step 2).
    get(_t, key, recv) { return _wrapForHostGet(closure, exports, key, recv); },
    set(_t, key, val) { _safeSet(closure, key, val, exports); return true; },
    has(_t, key) { return _wrapForHostHas(closure, exports, key); },
    getPrototypeOf() { return Function.prototype; },
  };

  const proxy = new Proxy(fnTarget, handler);
  _hostCallableCache.set(closure, proxy);
  _hostProxyReverse.set(proxy, closure); // so _unwrapForHost round-trips
  return proxy;
}
```

`_wrapWasmClosureByArgCount(closure, n, exports)` is a thin helper over the
existing `_wrapWasmClosure` that selects `__call_fn_min(n, maxArity)` rather
than a fixed arity — reuse the `for (arity = 4; arity >= 0; arity--)` discovery
loop already in `_maybeWrapCallableUnknownArity` (runtime.ts:1519) to find the
highest emitted `__call_fn_*`, then clamp to `n`.

## Step-by-step implementation

1. **Factor shared read/has logic out of `_wrapForHost`.** Extract the
   `safeGetField` + closure-bridge `get` body (runtime.ts:3601-3748) and the
   `has` body (3754-3772) into free functions `_wrapForHostGet(obj, exports,
   key, recv)` and `_wrapForHostHas(obj, exports, key)`. `_wrapForHost`'s
   existing handler calls them; the new callable wrapper reuses them verbatim.
   No behavior change to `_wrapForHost` — pure extraction (verify by running
   the existing `_wrapForHost`-dependent suites unchanged).

2. **Add `_wrapCallableForHost` + `_hostCallableCache` + the arity helper** as
   above.

3. **Route the construct sites to the callable wrapper when the target is a
   closure.** In each of these, when `_isWasmStruct(x)` *and* `__is_closure(x)
   === 1` (the authoritative closure discriminator, runtime.ts:1512), use
   `_wrapCallableForHost` instead of `_wrapForHost`:
   - `__reflect_construct` (7061): `wrappedCtor`.
   - `__construct` (7081): `wrappedCallee` — the `isCtor` probe
     (`Reflect.construct(function(){}, [], wrappedCallee)`) then *passes*
     because the callable wrapper is constructible, so the spec TypeError for
     genuinely-non-constructible values is still thrown for non-closure
     structs (which keep going through `_wrapForHost`).
   - **Promise combinators** are the subtle one: the wrapped `C` is *not*
     constructed by our code — V8 does it inside `Promise.all.call(C, …)`. So
     `_resolveCtor` (runtime.ts:7822) must return a **constructible** `C` for
     the `.call(closure, …)` case. Add: if `directCall === 0` and
     `_isWasmStruct(thisArg)` and it is a closure, return
     `_wrapCallableForHost(thisArg, exports)`; else return `thisArg`
     unchanged (preserves the correct ctx-non-object / ctx-non-ctor throws —
     a plain object or non-closure struct stays non-constructible, so V8's
     NewPromiseCapability still throws TypeError per §27.2.4.X step 2).

4. **`__construct_closure` export (compiled-class path).** For sub-case (1) of
   the `construct` trap — a compiled *class* constructor used dynamically — the
   codegen must expose a construct entry. Check whether `__new_<Class>` exports
   already exist for declared classes (grep `__new_` in
   `src/codegen/class-bodies.ts`); if a generic `__construct_closure(closureRef,
   argsVec)` dispatcher does not exist, emit one analogous to `__call_fn_N`:
   a `br_table`/if-chain over the closure's class tag that calls the matching
   constructor body with the materialized args, returning the new instance
   externref. If the compiled-class-as-dynamic-ctor case has **no test262
   coverage in the target suites** (A.i's `NotPromise` is an *ordinary*
   function, not a class), gate sub-case (1) behind a follow-up and ship the
   ordinary-[[Construct]] fallback (sub-case 2) first — that alone closes A.i.

## Edge cases

- **`typeof` must be `"function"`.** Because the Proxy target is a `function`,
  `typeof proxy === "function"` holds automatically — required for V8's
  `IsConstructor` / `IsCallable` internal checks and for any host code that
  branches on `typeof`.
- **Identity / caching.** Cache per closure (`WeakMap`) so repeated wraps of
  the same closure return the same Proxy — `Promise.all.call(C,…)` then
  `C === C` holds across calls, and `@@species` lookups that compare
  constructors stay stable. Mirror into `_hostProxyReverse` so
  `_unwrapForHost` (runtime.ts:3877) returns the original closure when the
  value flows back into Wasm.
- **`.prototype` access.** `NewPromiseCapability` and `OrdinarySpeciesConstructor`
  read `C.prototype`. The `get` trap delegates to `_wrapForHostGet`; if the
  closure has no `prototype` sidecar, return a fresh ordinary object once and
  cache it on the sidecar so `instanceof`/proto identity is stable. (For the
  ordinary-function A.i case V8 only needs `.prototype` to exist as an object.)
- **Non-closure structs keep the old wrapper.** Only values where
  `__is_closure === 1` get the callable wrapper. A plain wasm-struct instance
  passed where a constructor is expected must still be non-constructible so the
  spec TypeError fires (this is what keeps ctx-non-object / ctx-non-ctor green).
- **Standalone / no-JS-host mode.** This wrapper is JS-host-only (it is a
  `Proxy` over host `Reflect.construct`). Under `ctx.standalone ||
  noJsHost(ctx)` there is no host to call/construct through; the existing
  standalone degrade paths (identity-bind, etc.) are unchanged. No new host
  import is added — `_wrapCallableForHost` lives inside the existing host glue,
  reachable only when `callbackState`/`exports` are present, so the
  host-import-allowlist budget is untouched.
- **Abrupt completion / executor throw.** The `construct` trap must let a throw
  from the compiled body propagate (do not swallow) so
  `capability-executor-not-callable` / `capability-resolve-throws` ordering is
  observed by V8's NewPromiseCapability.

## Test262 buckets to re-run after landing

- `built-ins/Promise/{all,allSettled,any,race}/*ctor*`,
  `*resolve-from-same-constructor*`, `*species*`,
  `*capability-executor*` — confirm A.i `NotPromise` family flips
  (the #1694 sole-remaining gap).
- `built-ins/Function/prototype/bind/*` `new (fn.bind(...))()` cases —
  #1632a construct residual.
- `built-ins/Reflect/construct/*` dynamic compiled-fn cases — #1596 / #1732 S1.

## Verification harness note (carried from #1694 re-validation)

Use the **two-step** `WebAssembly.compile(binary)` then
`instantiate(mod, importObject)` (the one-step `instantiate(binary, …)` races
the lazy `importObject` getter and gives false "no export" failures), and
assert any TypeError outcome **inside** the compiled function returning a
sentinel — a host-side `try` around `inst.exports.go()` is unreliable.

## Suggested split

- **#1632b-1** ✅ **DONE 2026-06-17** (closes #1694 A.i, shipped with the #1694
  PR): `_wrapCallableForHost` + `_hostCallableCache` in `src/runtime.ts`
  (a `Proxy` over a real `function` target with `apply`/`construct` traps that
  dispatch through `_wrapWasmClosureUnknownArity`; all other traps delegate to
  the existing `_wrapForHost(closure)` proxy, so no extraction of `_wrapForHost`
  was needed — lower risk than the spec's step-1 option). The `construct` trap
  implements the ordinary-`[[Construct]]` fallback (sub-case 2). Hooked into
  `_resolveCtor` for `directCall === 0` + `__is_closure === 1`. No codegen
  change. The A.i `NotPromise` capability-constructor family is flipped; the
  `ctx-non-object`/`ctx-non-ctor` TypeErrors and the B/A.ii subclass paths are
  preserved. See `plan/issues/1694-promise-subclass-capability.md`
  "Implemented #1632b-1".
- **#1632b-2** (compiled-class-as-dynamic-ctor, needs codegen): step 4
  (`__construct_closure` export). Only if test262 evidence shows a
  compiled-*class* reaching a dynamic construct site uncovered by #1682.
  Still open — out of scope for the #1694 PR (A.i's `NotPromise` is an
  ordinary function, not a class).
