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

- [ ] The 8 failing rows above pass on the host lane
- [ ] `prop-desc.js` still passes (do not regress #4739)
- [ ] `f[Symbol.hasInstance] === g[Symbol.hasInstance]` for two compiled functions
- [ ] `x instanceof f` unchanged for every existing passing row — the step-2
      identity check is the specific risk
- [ ] Standalone lane unchanged (#4676's path is not touched)
