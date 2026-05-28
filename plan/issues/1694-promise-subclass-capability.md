---
id: 1694
title: "Promise.any/all/allSettled/race: non-Promise capability `this` + extends-Promise codegen (~50 fails)"
status: backlog
created: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: promises, subclassing
goal: spec-completeness
sprint: Backlog
related: [1368, 1465, 1528, 1116, 1644, 1682]
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
