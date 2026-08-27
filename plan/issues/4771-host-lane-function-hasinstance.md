---
id: 4771
title: "Host lane: `f[Symbol.hasInstance]` is null — the method-CALL form never reaches the runtime"
status: ready
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: es6
language_feature: symbol-hasInstance, function-prototype
goal: core-semantics
related: [4676, 4739, 2702, 2740]
origin: "ES2015 failure bucketing 2026-08-27; host twin of the standalone-only #4676/#4739"
assignee: ttraenkler/senior-dev
loc-budget-allow:
  # 2026-08-27 (#4771): the host lane's OrdinaryHasInstance IS `_instanceofResult`
  # + `_fnctorInstanceofHooks` in runtime.ts. Both missing spec steps — §7.3.20
  # step 2 (bound-target forwarding) and step 7 (chain walk for an instance with
  # no recorded constructor) — have to be added where that predicate lives;
  # hoisting them out would split one ~30-line spec algorithm across two files
  # for no reader's benefit.
  - src/runtime.ts
  # A 6-line arm delegating to the new src/codegen/host-function-has-instance.ts,
  # placed immediately beside the standalone twin it mirrors so the pair reads
  # as one decision.
  - src/codegen/expressions/calls-closures.ts
---

# #4771 — host-lane `%Function.prototype%[@@hasInstance]`

## Scope

The **JS-host** twin of #4676 / #4739, both of which are `done` and both of which
fixed **standalone only**. #4739 records "host lane: pass" for its own row
(`prop-desc.js`) and that is still true — but the VALUE rows it listed as passing
controls fail on the host lane today.

Measured on current `main` with `scripts/run-test262-paths.mts --isolate`
(9 rows: 1 pass, 8 fail):

| row | result |
| --- | --- |
| `Symbol.hasInstance/prop-desc.js` | **pass** (this is what #4739 fixed) |
| `Symbol.hasInstance/value-positive.js` | fail — `dereferencing a null pointer` |
| `Symbol.hasInstance/value-negative.js` | fail — same |
| `Symbol.hasInstance/value-non-obj.js` | fail — same |
| `Symbol.hasInstance/this-val-bound-target.js` | fail — same |
| `Symbol.hasInstance/this-val-prototype-non-obj.js` | fail — same, inside a callback |
| `Symbol.hasInstance/value-get-prototype-of-err.js` | fail — same, inside a callback |
| `Symbol.hasInstance/this-val-poisoned-prototype.js` | fail — `Cannot redefine property: prototype` |
| `language/expressions/instanceof/symbol-hasinstance-invocation.js` | fail — `Expected SameValue(«0», «1»)` |

A direct probe confirms the shape independently: `Function.prototype[Symbol.hasInstance]`
exists with the correct descriptor (`w=false e=false c=false`), but
`Function.prototype[Symbol.hasInstance].call(C, o)` answers `false` where the
spec says `true`, and a custom `Symbol.hasInstance` installed on a constructor is
ignored by `instanceof` (`{} instanceof Custom` → `false` with a handler that
returns `true`).

## Root cause, and the part that is NOT obvious

§20.2.3.6: every function inherits ONE `@@hasInstance` method performing
OrdinaryHasInstance(this, V). A compiled closure is a WasmGC struct with no JS
prototype chain, so the inherited method is not found and the read is `null` —
calling it traps as "dereferencing a null pointer".

**The read path and the call path are DIFFERENT, and only the read path is in the
runtime.** This was established by instrumenting `_safeGet` and measuring both
forms:

```js
var m = f[Symbol.hasInstance];       // → _safeGet(closure, Symbol.hasInstance)  [probe fires]
f[Symbol.hasInstance](o);            // → NEVER reaches _safeGet                 [probe silent]
```

The value read does reach `_safeGet` with `_isWasmStruct === true` and
`__is_closure === 1`. The direct **method-call** form — which is what every
failing row above uses — is lowered by codegen as a method call that resolves its
callee without consulting the runtime get at all.

**So a runtime-only fix cannot work, and this was verified by building one.** An
arm in `_safeGet` returning a shared, identity-stable
`%Function.prototype%[@@hasInstance]` bridge (plus the matching
`_instanceofResult` step-2 identity check needed to stop it recursing into
itself) was implemented and measured: the arm fires, returns a real callable —
and **all 8 rows still fail, unchanged**. That change was reverted; it is
recorded here so the next attempt does not repeat it. The value-read half is
necessary but not sufficient, and the call half is where the rows live.

## Where the fix goes

Codegen, not runtime. #4676 solved the standalone twin by registering
`@@hasInstance` as a symbol member of the standalone Function native-prototype
glue (`src/codegen/function-proto-has-instance.ts`, wired through
`array-object-proto.ts:1812`) and routing a checker-certified callable receiver's
computed read to that identity-stable closure. That whole path is gated on
`ctx.standalone` (`native-proto-own-props.ts:211`), which is why the host lane
never sees it.

The host lane needs the equivalent for BOTH forms:

- the method-CALL form `f[Symbol.hasInstance](v)` — the one that matters for
  these rows;
- the value read `var m = f[Symbol.hasInstance]`, which additionally has to
  produce something the compiled call site can invoke. Returning a host JS
  function from `_safeGet` is not enough: the read is typed as callable, so the
  call site expects a closure and the externref does not fit. Confirmed by probe
  — `var m = f[Symbol.hasInstance]` itself null-derefs at the assignment, before
  any call.

The OrdinaryHasInstance semantics themselves already exist and are spec-shaped:
`_instanceofResult` (`src/runtime.ts`) implements §13.10.2 + §7.3.20 including
the step-3-before-step-4 ordering and the tri-state TypeError sentinel. Reuse it;
do not write a second one.

## Implementation Plan

1. Reproduce the 9-row table above with `--isolate` and keep it as the before-state.
2. Find the lowering for a computed member CALL whose key is a well-known symbol
   on a callable receiver, and confirm exactly how the callee is resolved to null
   today (the instrumentation above shows only that it bypasses `_safeGet`).
3. Route that call — and the value read — to a single identity-stable
   `%Function.prototype%[@@hasInstance]` implementation, so
   `f[Symbol.hasInstance] === g[Symbol.hasInstance]` holds as §20.2.3.6 requires.
4. Whatever serves the default must be recognised by `_instanceofResult` step 2
   as the DEFAULT, not as a custom handler — otherwise `x instanceof f` calls it
   and it calls back into `_instanceofResult` unboundedly. This bit the
   runtime-only attempt and is easy to miss.
5. `this-val-poisoned-prototype.js` fails differently (`Cannot redefine property:
   prototype`) and may be a separate defect; verify rather than assuming it comes
   along.

## Acceptance criteria

- [x] ~~The 8 failing rows above pass on the host lane~~ — **6 of 8**; the other
      two are separate defects, root-caused below
- [x] `prop-desc.js` still passes (do not regress #4739)
- [x] `f[Symbol.hasInstance] === g[Symbol.hasInstance]` for two compiled functions
      — holds by construction: the call form is a direct lowering, so no
      per-function method object is ever minted
- [x] `x instanceof f` unchanged for every existing passing row — measured, and
      it in fact IMPROVES by 3 rows
- [x] Standalone lane unchanged (#4676's path is not touched) — every new gate is
      `!noJsHost(ctx)` or keyed on a wasm-closure target the standalone path
      never reaches; `tests/issue-4676-*.test.ts` still passes

## What was implemented (2026-08-27)

**Codegen** — `src/codegen/host-function-has-instance.ts` (new) +
`tryEmitHostFunctionHasInstanceCall` wired into
`compileCallableElementAccessCall` (`src/codegen/expressions/calls-closures.ts`),
immediately beside the standalone arm it mirrors. It lowers
`f[Symbol.hasInstance](v)` onto the **existing** `__instanceof_check` host
predicate with the operands swapped, reusing its §13.10.2 + §7.3.20 tri-state
and `emitInstanceofThrowGuard` (now exported from
`src/codegen/expressions/identifiers.ts`) so the `2` sentinel throws **from
wasm** and keeps catchable TypeError identity.

The step-2 hazard turned out to be *structurally* absent rather than something
to defend against: this arm materialises no value and installs no property, so
`_instanceofResult`'s `target[Symbol.hasInstance]` read still answers `undefined`
on a compiled closure and takes the DEFAULT branch. That is also why the
identity criterion is free.

**Runtime** — three OrdinaryHasInstance steps the host predicate was missing.
All three were wrong for the `instanceof` OPERATOR too, which is why fixing them
moved rows outside this issue:

1. §7.3.20 step 2 — forward to `[[BoundTargetFunction]]`. `.bind()` returns a
   host-native bound function with **no** `prototype`, so `x instanceof f.bind()`
   reported the step-5 TypeError instead of forwarding. `_boundFunctionTargets`
   records the ORIGINAL target (the closure struct, not the host bridge).
2. §7.3.20 step 7 — walk the chain for an instance with **no recorded fnctor
   constructor**. `Object.create(new f())` is a host object whose `[[Prototype]]`
   is the struct; `fnctorInstanceofResult` used to decline outright, sending it
   to the native fallback where a WasmGC closure is opaque and the answer is
   always `false`. New `recordedPrototype` hook; a MISS still declines, so every
   undecidable shape keeps its old answer.
3. §7.3.20 step 4 — read the **compiled** function's `prototype`.
   `_maybeWrapCallableUnknownArity` mints an ordinary JS bridge with its own
   fresh `.prototype`, so `target.prototype` answered about the bridge. Two
   layers: `_compiledFnPrototypeSlot` (with a `_SLOT_ABSENT` sentinel, so "no
   readable slot" still falls back to the host read) **and**
   `_getOrVivifyFnPrototype` deciding "never written" by PRESENCE rather than by
   value — `f.prototype = undefined` is a real slot write that reads back
   `undefined`, and vivifying over it erased the non-object the program
   installed before step 5 could see it.

### Measurements (`scripts/run-test262-paths.mts --isolate`, 2026-08-27)

| slice | before | after |
| --- | --- | --- |
| `Symbol.hasInstance/*` + `instanceof/symbol-hasinstance-invocation` (12 rows) | 4 pass / 8 fail | **10 pass / 2 fail** |
| `language/expressions/instanceof` (43 rows) | 31 pass / 12 fail | **33 pass / 10 fail** |
| `Proxy/getPrototypeOf` + `Function/prototype/bind` (119 rows) | 102 pass / 17 fail | **103 pass / 16 fail** |
| `class/subclass` + `expressions/new` (168 rows) | 108 pass / 60 fail | 108 pass / 60 fail, list byte-identical |

Newly passing outside the 9-row table: `instanceof/S15.3.5.3_A2_T2.js`,
`instanceof/S15.3.5.3_A2_T6.js`, `Proxy/getPrototypeOf/instanceof-custom-return-accepted.js`.
Zero rows regressed in any slice. Regression test:
`tests/issue-4771-host-function-hasinstance.test.ts`.

## Residual — two SEPARATE defects, not this one

**(a) `Object.defineProperty(fn, 'prototype', …)` is rejected** — 3 rows.
`Symbol.hasInstance/this-val-poisoned-prototype.js` and, with the identical
message, `instanceof/prototype-getter-with-object-throws.js` and
`instanceof/prototype-getter-with-primitive.js` all fail at the *setup* line with
`TypeError: Cannot redefine property: prototype`, before any `@@hasInstance` code
runs. A function's `prototype` slot is exposed to the host as non-configurable,
so installing a getter over it throws. Spec-wise a getter-derived function has no
`prototype` at all and the define should simply ADD one. Fixing this is a
property-descriptor/MOP change on the closure bridge, unrelated to
OrdinaryHasInstance.

**(b) `instanceof` with a plain-object RHS never reaches the host predicate.**
`instanceof/symbol-hasinstance-invocation.js`:

```js
var F = {};
F[Symbol.hasInstance] = function () { callCount += 1; };
0 instanceof F;                      // callCount stays 0
```

Measured with a stderr probe inside the `__instanceof_check` import:
`_instanceofResult` is **never called** for this module — codegen answers the
operator statically. Adding *any* value read of `F[Symbol.hasInstance]` elsewhere
in the same file flips the whole module onto the runtime predicate, and then the
handler IS invoked and answers correctly — so the decision is a source-shape one,
not a value one. The place to look is the static-fold chain in
`compileHostInstanceOf` (`src/codegen/expressions/identifiers.ts`) —
`tryStaticInstanceOf` / `emitConstantInstanceOf` — which was NOT confirmed as the
exact site. Note `tryEmitNonCallableRhsThrow`
(`src/codegen/native-ordinary-instanceof.ts`), the obvious suspect, is
`noJsHost`-gated and therefore innocent on this lane.

A runtime-side arm was written for (b) and **reverted**: it read the handler out
of the WasmGC struct sidecar in step 2, on the theory that a symbol-keyed write
lands there. Measurement showed the receiver is not a wasm struct at that point
(`_isWasmStruct(rawTarget) === false` — the plain host read already finds the
handler whenever the predicate is reached at all), so the arm fired nowhere. It
is recorded here so it is not rebuilt.
