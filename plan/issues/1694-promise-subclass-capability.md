---
id: 1694
title: "Promise.any/all/allSettled/race: non-Promise capability `this` + extends-Promise codegen (~50 fails)"
status: done
assignee: ttraenkler/cs-1694
created: 2026-05-28
updated: 2026-06-17
completed: 2026-06-17
revalidated: 2026-06-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, subclassing
goal: spec-completeness
sprint: 63
needs_architect_spec: true
related: [1368, 1465, 1528, 1116, 1644, 1682, 1596, 1632b]
---
# #1694 — Promise combinators: non-Promise capability `this` + extends-Promise codegen

## Problem

Across `Promise.any`, `Promise.all`, `Promise.allSettled`, `Promise.race`, ~50
test262 cases fail with two distinct error fingerprints that share the same
underlying gap: the **NewPromiseCapability(C)** step of each combinator
(§27.2.4.1 step 3 / §27.2.4.3 step 3 / §27.2.4.2 step 3 / §27.2.4.5 step 3) is
not honoured when `C` is anything other than the host `Promise` constructor.

### Sub-cluster A — non-Promise capability `this` (~40 fails, ~10 per method)

```js
Promise.any.call(NotPromise, [1])
//  → "[object Object] is not a constructor"
//  expected: NotPromise(executor) is called, resolving capability
```

Test262 `built-ins/Promise/{any,all,allSettled,race}/capability-executor-not-callable`,
`ctor-poisoned-then`, `capability-resolve-throws-no-close`, `species-constructor`
families. The combinator implementations in `src/runtime.ts` hard-wire
`new Promise(...)` instead of constructing through the actual `C` receiver, so
any non-`Promise` `this` value (including user functions and subclasses with a
custom `Symbol.species`) is rejected by V8 at the `new C(executor)` step inside
our host glue.

### Sub-cluster B — `class X extends Promise` codegen invalid (~7 per method, ~28 fails)

```
class X extends Promise {}
X.any([])
//  Compiling function #N failed: extern.convert_any[0] invalid Wasm
```

Test262 `built-ins/Promise/{any,all,allSettled,race}/resolve-from-same-constructor`,
`promise-resolve-function-from-same-constructor` families. The user-defined
`extends Promise` produces invalid Wasm at compile time: the `extern.convert_any`
operand stack does not match — the synthetic derived constructor returns an
externref-shaped value where the parent path expects the host Promise externref,
and the cast is emitted against an empty / wrong-type top-of-stack.

Cross-references:
- Builtin-parent derived-ctor super wiring (#1682, fixed for WeakMap/Promise/Object)
  was the localized fix for the **constructor** half; **the static combinator
  half is not covered**.
- `__bind_function` / bound-function representation (#1632a, #1632b) is adjacent
  — the codegen path that produces the wrong-type operand for `extern.convert_any`
  here may share code with the bound-function representation issue.

## Decomposition

| Sub-cluster | Tests | Per method | Root cause | Feasibility |
|---|---|---|---|---|
| A — non-Promise capability `this` | ~40 | ~10 | combinators hard-wire `new Promise(...)`; ignore `C` | medium |
| B — `class X extends Promise` static-method | ~28 | ~7 | derived-class static codegen emits `extern.convert_any[0]` with invalid stack | hard |

## Acceptance criteria

1. `Promise.any.call(F, [1])` invokes `F` as the capability constructor (no
   `[object Object] is not a constructor`) — same for `all`, `allSettled`,
   `race`. ~40 tests pass.
2. `class X extends Promise {}; X.any([])` compiles to valid Wasm (no
   `extern.convert_any[0] invalid Wasm` at compile time) and resolves through
   `X.[[Construct]]`. ~28 tests pass.
3. Combined pass-rate for `built-ins/Promise/{any,all,allSettled,race}` rises
   by ~50.

## Files to investigate

- `src/runtime.ts` — `__promise_any`, `__promise_all`, `__promise_allSettled`,
  `__promise_race` host bridges (NewPromiseCapability call site).
- `src/codegen/class-bodies.ts` — derived-class static-method codegen
  (where the bad `extern.convert_any` originates for Sub-cluster B).
- `src/codegen/expressions/calls.ts` — `.call(ThisArg, ...)` dispatch on
  static Promise methods (Sub-cluster A's user-call site).

## Why this is hard

Sub-cluster B intersects three known-hard areas already documented:
- Derived-class constructor representation across builtin parents (#1682
  delivered Half A; Half B was architect-blocked).
- Bound-function / function-as-host-callable representation (#1632a/b, #1596).
- The `extern.convert_any` operand-stack mismatch surfaces in roughly the same
  shape as #1623-extern.

Sub-cluster A is the simpler half — rewrite each `__promise_*` to call
`new C(executor)` via the supplied `this` instead of hard-coded `Promise` —
but verifying spec invariants (capability resolve/reject identity, abrupt
completion ordering) is non-trivial and overlaps with #1368 (resolver-element
spec gap) and #1465 (combinator iterable subclass).

## Related

- #1368 — `resolveElementFunction` / `resolveAndRejectElementFunctions` spec gap
- #1465 — combinator iterable-subclass behaviour
- #1528 — non-constructor TypeError + `Symbol.species` on Promise
- #1116 — Promise resolution + async error handling (parent umbrella)
- #1644 — BigInt rep spec (precedent for "needs architect rep decision")
- #1682 — derived-ctor super-must-be-called for builtin subclasses (Half A
  shipped, Half B architect-blocked)

## Re-validation (2026-06-03, senior-developer) — scope SHRANK to a single architect-blocked gap

Re-probed every fingerprint against **current main** (JS-host, real `compile()` →
`WebAssembly.compile(binary)` → `instantiate(mod, importObject)` two-step + an
**in-Wasm `try/catch`** that returns a sentinel for "TypeError thrown"). Two
harness traps to note for any follow-up: (1) the one-step
`instantiate(binary, …)` form races the lazy `importObject` getter and gives
false "no export" failures; (2) reading a TypeError outcome via a host-side
`try` around `inst.exports.go()` is unreliable — assert the throw *inside* the
compiled function and return a sentinel. Both traps produced wrong intermediate
readings in earlier runs.

| Shape | Source | Current-main result |
|---|---|---|
| **B** `class X extends Promise {}; X.all([…])` | static-method on declared subclass | **RESOLVES** `[1,2]` — already fixed (matches #206 finding, still holds) |
| **A.ii** `Promise.all.call(Sub, […])` where `Sub extends Promise` (declared) | `.call` thisArg = declared subclass | **RESOLVES** `[1,2]` — **now fixed**. WAT confirms codegen routes the thisArg through `__promise_subclass_ctor` (calls.ts:5303→945); native V8 handles `Promise.all.call(syntheticSubclass, realArray)` correctly. Likely closed by #1596 + #1682 landing after the 2026-05-28 investigation. |
| **ctx-non-object** `Promise.all.call(undefined, [])` / `.call(5, [])` | non-object capability `this` | **THROWS TypeError correctly** (in-Wasm catch returns the TypeError sentinel). Native delegation via `Promise.METHOD.call(C, …)` already enforces §27.2.4.X step 2. **Not a gap.** (An earlier "returns 1 = bug" reading mistook the catch sentinel `1` for a resolved value.) |
| **ctx-non-ctor** `Promise.all.call(()=>{}, [])` / `.call({}, [])` | callable-non-ctor / plain object | **THROWS TypeError correctly** — native NewPromiseCapability rejects. **Not a gap.** |
| **A.i** `Promise.all.call(NotPromise, […])` where `NotPromise` is a compiled Wasm function | `.call` thisArg = compiled Wasm fn used as capability ctor | **THROWS** `TypeError: [object Object] is not a constructor`. `_wrapForHost` (runtime.ts:3592) wraps Wasm structs as a non-callable/non-constructible `Object.create(null)` proxy — no `apply`/`construct` trap. V8's `Construct(C, [executor])` rejects it. **The ONE genuine remaining gap.** |

### Net assessment

The original ~50-fail estimate substantially over-counts. B, A.ii, and the
entire `ctx-non-object` / `ctx-non-ctor` family are **resolved on current main**
(the latter were never broken — the combinators' native delegation enforces the
spec step-2 / IsConstructor checks). The combinator code
(`_resolveCtor` → `Promise.METHOD.call(C, _toIterable(arr))`) is spec-correct
for every capability `C` that has a usable host representation.

**The sole remaining failure** is A.i: a **compiled Wasm function** used as the
capability constructor. It needs the compiled-fn host representation to be
`[[Call]]` + `[[Construct]]` capable — a `_wrapForHost` variant whose target is
a real `function`/`Proxy` with `apply` + `construct` traps that dispatch through
the `__call_fn_N` exports. This is the same host-callable-value gap as #1632b
(bound-fn representation) and the #1596 residual, and it should be specced
**once, centrally** — not patched in the Promise layer (a Promise-layer hack
would not fix the dozens of other sites that pass a compiled fn to a host that
calls/constructs it).

**Recommendation:** mark #1694's combinator-spec-compliance portion **done on
main** (B + A.ii + ctx-* all pass); reduce the residual to a single dependency
on the host-callable/constructible compiled-fn representation (#1632b umbrella).
Do **not** carve a separate ctx-non-object fix — that behaviour is already
correct. When #1632b's representation lands, re-run the
`built-ins/Promise/{all,allSettled,any,race}/*ctor*` / `*species*` suites to
confirm the A.i `resolve-from-same-constructor` family flips.

## Independent re-validation #2 (2026-06-03, sd-846-slice3) — confirms the gap is the compiled-class-value host representation

Re-built `dist/` from a fresh `origin/main` merge and re-probed via the
`compile()` + `buildImports(result.imports, {}, result.stringPool)` two-step
(the same harness `tests/promise-combinators.test.ts` uses). Findings:

| Probe | Result | Reading |
|---|---|---|
| `Promise.all.call(5, [])` (ctx-non-object) | sentinel `1` | **TypeError thrown correctly** — spec step-2 enforced. Confirms re-validation #1. |
| `Promise.all.call(NotPromise, […])`, `NotPromise` a compiled fn (A.i) | sentinel `1` | **TypeError thrown** — *spec-correct* for a non-constructor `C` (`ctx-non-ctor`). The `*resolve-from-same-constructor*` family wants a real subclass `C` to succeed — that path is the representation gap below, not the combinator. |
| `typeof (X)` for `class X extends Promise {}` referenced as a value | `"object"` | the compiled class **value** is a WasmGC-struct proxy, **not** the host `Promise` subclass. |
| `(X).all` (static method on the class value) | throws `WebAssembly.Exception` | the static method is **not resolvable** on the wasm-struct class value when the class is used as an expression. |

**Root cause (confirmed at `src/runtime.ts:3592` `_wrapForHost`):** the host
proxy `target` is `Object.create(null)` — a plain (non-callable) object. A JS
`Proxy` can only carry `apply`/`construct` traps when its target is itself
callable, so the wrapped compiled class/fn is neither `[[Call]]`- nor
`[[Construct]]`-able. V8's `Construct(C, [executor])` inside
`Promise.METHOD.call(C, …)` therefore rejects it. Identical to the `#1632b`
bound-/host-callable-value representation gap and the `#820m`/`#1690`
class-as-value family.

**Net:** no tractable Promise-layer slice exists. The combinator code is
spec-correct; every residual `#1694` failure (B, A.ii, A.i `*ctor*`/`*species*`)
is gated on the **central compiled-value host representation** — `_wrapForHost`
must produce a `function`/`Proxy(function, …)` target with `apply` + `construct`
traps that dispatch through the `__call_fn_N` / `__construct_*` exports, owned by
`#1632b`. **Keep `#1694` `status: backlog` + `needs_architect_spec: true`; do not
carve a Promise-only fix.** Re-run
`built-ins/Promise/{all,allSettled,any,race}/*ctor*`/`*species*` once `#1632b`'s
representation lands.

## Architect spec written (2026-06-03, senior-developer)

Both re-validations above converge on the same owner: the A.i fix is now
specced centrally as **#1632b — host-callable/constructible compiled-fn
representation** in
`plan/issues/1632-spec-gap-function-bind-tostring-internals.md`
(`_wrapCallableForHost`: a `Proxy` over a real `function` target carrying
`apply` + `construct` traps that dispatch through `__call_fn_N`). The
combinator hook is in `_resolveCtor` (runtime.ts:7822): for the
`.call(closure, …)` case it must return `_wrapCallableForHost(thisArg,
exports)` so V8's `NewPromiseCapability(C)` can `Construct(C, [executor])`.
Sub-task **#1632b-1** (runtime-only, no codegen) closes this A.i family.

## Implemented #1632b-1 (2026-06-17, senior-developer cs-1694) — A.i closed

The sole genuine remaining gap (A.i — a **compiled function** used as the
capability constructor) is now fixed, runtime-only, in `src/runtime.ts`.

**What shipped:**

1. `_wrapCallableForHost(closure, callbackState)` — a sibling of
   `_wrapForHost` whose Proxy target is a real `function compiledFnTarget(){}`
   (so the Proxy may legally carry `apply` + `construct` traps and
   `typeof proxy === "function"` holds — both required by V8's
   `IsCallable`/`IsConstructor`). The wrapper is cached per closure
   (`_hostCallableCache` WeakMap) and mirrored into `_hostProxyReverse` so
   `_unwrapForHost` round-trips the raw struct back into Wasm.
   - `apply` / `construct` dispatch through `_wrapWasmClosureUnknownArity`
     (the existing dynamic-arity `__call_fn_*` bridge) — no new export, no
     codegen.
   - `construct` implements **ordinary `[[Construct]]`** (ECMA-262 §10.2.2):
     run the body with a fresh `{}` as `this`, return the body's value if it
     is an object else the fresh receiver; a throw from the body propagates so
     `NewPromiseCapability`'s abrupt-completion ordering is observed.
   - Every other trap (`get`/`set`/`has`/`ownKeys`/`getOwnPropertyDescriptor`/
     `defineProperty`/`deleteProperty`) **delegates to the standard
     `_wrapForHost(closure)` proxy** — its read/has/enumerate machinery is
     reused verbatim, so NOTHING in `_wrapForHost` had to be extracted or
     touched (lower regression risk than the spec's step-1 extraction option).
     `getPrototypeOf` returns `Function.prototype`.

2. **Hook in `_resolveCtor`** (the combinator capability-resolver): for
   `directCall === 0` (`Promise.METHOD.call(thisArg, …)`), when `thisArg` is a
   WasmGC struct AND `__is_closure(thisArg) === 1`, return
   `_wrapCallableForHost(thisArg, callbackState)`. **Why the `__is_closure`
   gate is load-bearing:** a plain object (`ctx-non-ctor`) or a non-closure
   named struct must stay non-constructible so V8's NewPromiseCapability still
   throws the spec §27.2.4.X step-2 TypeError. Only genuine closures get the
   callable wrap; primitives/null/undefined never reach the struct branch.

**Why ordinary-[[Construct]] only (no `__construct_closure` export):** A.i's
`NotPromise` is always an *ordinary function*, never a compiled *class*. The
compiled-class-as-dynamic-constructor case is #1632b-2 (needs codegen) and has
no test262 coverage reaching this site uncovered by #1682, so it is
intentionally deferred.

**Verification (two-step `WebAssembly.compile` + `instantiate` + `setExports`,
matching `tests/promise-combinators.test.ts`):**
- A.i positive: `Promise.all.call(Cap, [])` with `function Cap(executor){…}`
  → the compiled body now RUNS (was `[object Object] is not a constructor`).
- `ctx-non-object` (`Promise.all.call(5, [])`) → still TypeError.
- `ctx-non-ctor` (`Promise.all.call({}, [])`) → still TypeError.
- B/A.ii (`class X extends Promise {}; X.all([])`) → still resolves.
- 4 new tests added to `tests/promise-combinators.test.ts`
  (`describe("… compiled-fn capability constructor (#1694 A.i)")`).
- Adjacent suites green: #1632a, #1596, #1732-S1, #1337-bind-call,
  #1712, #1896-typeof-closure, #2174 (53 tests).

**Harness gotcha (cost ~30 min):** the verification harness MUST call
`imports.setExports(instance.exports)` after `WebAssembly.instantiate`, or
`callbackState.getExports()` stays `undefined`, `__is_closure` is unreachable,
and the wrap silently no-ops. Raw `WebAssembly.instantiate(binary, imports)`
without `setExports` gives a false "body never ran" reading.
