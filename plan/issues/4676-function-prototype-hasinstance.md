---
id: 4676
title: "ES2015 standalone Function.prototype @@hasInstance value and receiver semantics"
status: done
assignee: codex/es6-functionproto-wave3
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
es_edition: es6
language_feature: function-prototype, symbol-hasInstance
goal: standalone-mode
related: [4444, 2175, 4265]
origin: "ES2015 standalone close-out residual triage from #4444; fresh assignment #4676"
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/property-access.ts
  - src/codegen/array-object-proto.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccess
---

# #4676 — Function.prototype `@@hasInstance` value/receiver semantics

## Scope

This issue owns the ordinary, non-reflection method-value gap for the
ES2015 `Function.prototype[@@hasInstance]` method. The bounded target is the
four rows whose only missing operation is reading the inherited method from a
callable value and invoking OrdinaryHasInstance:

```
built-ins/Function/prototype/Symbol.hasInstance/value-positive.js
built-ins/Function/prototype/Symbol.hasInstance/value-negative.js
built-ins/Function/prototype/Symbol.hasInstance/value-non-obj.js
built-ins/Function/prototype/Symbol.hasInstance/this-val-bound-target.js
```

The implementation must preserve the callable receiver and argument order,
return a boolean (not a boxed number), and throw a catchable TypeError when
the candidate constructor has a non-object `prototype`. Proxy/accessor error
propagation is not included in this bounded slice because the standalone Proxy
substrate is a separate residual. `%Function.prototype%` descriptor/name/
length rows remain with the method-metadata/reflection work (#2175 and the
existing #4265 plan); bind construction, `call`, and `apply` rows remain with
their existing owners.

## Plan

1. Register `@@hasInstance` as a symbol member of the standalone Function
   native-prototype glue and emit its method closure through the existing
   host-free dynamic OrdinaryHasInstance helper.
2. Route a checker-certified callable receiver's computed
   `f[Symbol.hasInstance]` value read to that identity-stable closure, while
   keeping unknown/possibly-overridden receivers on the existing dynamic path.
3. Add focused runner coverage for the four rows and a direct boolean/TypeError
   probe. Run the selected rows before and after the change and record every
   flip plus zero-loss evidence against the fresh branch baseline.

## Root cause

`Symbol.hasInstance` already lowers to the native well-known-symbol id, but
the standalone Function native-prototype glue only advertises string members
(`apply`, `bind`, `call`, `toString`). A computed read therefore falls through
to the generic closure/object property path, which has no symbol member for the
inherited Function prototype method and returns the undefined sentinel. The
subsequent call either null-dereferences or returns the wrong value. The
host-free `__instanceof_dynamic(value, target)` helper already implements the
representation-aware OrdinaryHasInstance walk and its tri-state TypeError
sentinel; this slice adapts that helper to the method closure ABI.

## Test Results

Baseline measured on branch `c5270b9d71fad31cd508b726e797554bfa115ff1`
(`upstream/main` at worktree creation), with a fresh standalone JSONL fetched
using `scripts/fetch-baseline-jsonl.mjs --standalone --force` (48,735 entries).
The in-process runner used isolated pnpm dependencies and
`runTest262File(..., "standalone")`:

| Row | Baseline |
| --- | --- |
| `value-positive.js` | fail — null pointer in `__module_init` at the method call |
| `value-negative.js` | fail — null pointer in `__module_init` at the method call |
| `value-non-obj.js` | fail — null pointer in `__module_init` at the method call |
| `this-val-bound-target.js` | fail — null pointer in `__module_init` at the method call |

Fresh branch probes also recorded `this-val-not-callable.js` and
`this-val-prototype-non-obj.js` as passing already; they are retained as
no-loss guards, not claimed conversions. `value-get-prototype-of-err.js` and
`this-val-poisoned-prototype.js` remain explicit Proxy/accessor residuals.

After the native closure, receiver-binding arm, and fnctor edge registration:

| Row | After |
| --- | --- |
| `value-positive.js` | pass |
| `value-negative.js` | pass |
| `value-non-obj.js` | pass |
| `this-val-bound-target.js` | pass |
| `this-val-prototype-non-obj.js` (no-loss guard) | pass |
| `this-val-not-callable.js` (no-loss guard; direct standalone equivalent) | pass |
| `value-get-prototype-of-err.js` (Proxy/accessor residual) | fail — expected unsupported `GetPrototypeOf` error propagation |
| `this-val-poisoned-prototype.js` (accessor residual) | fail — expected unsupported accessor throw propagation |

Focused regression coverage:

```
pnpm exec vitest run tests/issue-4676-function-prototype-hasinstance.test.ts  # 3 passed
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json     # passed
```

The direct standalone equivalent of `this-val-not-callable.js` is covered in
the focused test because the upstream row's runner asks for the unavailable
QuickJS eval-provider artifact on this workstation; no source failure was
observed. An additional reassignment probe (`var F = function() {}; F = G`)
returned `old prototype → false` and `new prototype → true`; the edge collector
now conservatively declines mutable module bindings so this identity guard
cannot report a stale prototype.

## Residuals

The symbol-keyed descriptor/metadata rows (`prop-desc.js`, `name.js`, and
`length.js`) are reflection work and are not part of this issue. Proxy
`[[GetPrototypeOf]]`/accessor error propagation remains a separate standalone
Proxy/object-runtime gap. GeneratorFunction, `toString`, and ordinary
`call`/`apply`/`bind` rows are owned by their existing lanes.
