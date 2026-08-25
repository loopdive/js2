---
id: 4725
title: "ES2015 Map.prototype.forEach forwards thisArg in standalone"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: map-foreach
es_edition: es2015
goal: spec-completeness
sprint: 77
oracle-ratchet-allow:
  - src/codegen/map-runtime.ts
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsClosure
---
# #4725 — ES2015 Map.prototype.forEach forwards thisArg in standalone

## Live baseline (upstream/main `62eace929`)

The exact Test262 residual
`built-ins/Map/prototype/forEach/second-parameter-as-callback-context.js`
passes in the JS-host lane but fails in `--target standalone`:

```text
host:       pass
standalone: fail — Expected SameValue(«undefined», «[object Object]»)
            at L35: assert.sameValue(_this[0], expectedThis)
```

The standalone native collection path in `src/codegen/map-runtime.ts` invokes
the closure with value/key/collection arguments but never installs the optional
second argument as `__current_this`. The callback therefore observes the
unbound value instead of the supplied object. Nearby controls measured with the
same runner: `callback-this-{strict,non-strict}.js`, insertion-order mutation,
delete-during-iteration, delete/re-add mutation, and abrupt callback completion
pass in both lanes; `callback-parameters.js` is a separate standalone failure
(`results[0]` is undefined) and is not admitted without a shared root cause.

## Implementation plan

1. In the native `Map`/`Set` forEach lowering, evaluate the callback first and
   then an explicitly supplied non-arrow `thisArg`, preserving call argument
   order.
2. Save/install `__current_this` around each native `call_ref`, then restore it
   after the callback. Leave arrow callbacks lexical and preserve the no-
   `thisArg` behavior.
3. Add focused host/standalone regression coverage for object identity,
   callback argument order, insertion-order mutation, and nested callback
   restoration; retain existing Map/Set native controls.
4. Run the exact Test262 file plus nearby controls in host and standalone, then
   the focused issue test and requested TS5/TS7/typecheck/lint/format/prepush
   checks.

## Diagnosis and implementation

The standalone callback value for a pre-bound function expression is lowered
through an `externref` local, so the original native forEach gate rejected it
before reaching `call_ref`. The fix admits a single statically callable
signature, recovers its canonical closure wrapper (the same mechanism used by
array HOFs), and then installs/restores `__current_this` around each callback.
Function expressions that read their own `this` now ensure that global is
available when their lifted body is compiled. Arrow callbacks still evaluate
but ignore `thisArg`.

## Test Results

- Exact residual `second-parameter-as-callback-context.js`: host pass,
  standalone pass.
- Nearby callback/argument/mutation controls (`callback-parameters.js`,
  strict/non-strict callback-this, insertion-order mutation,
  delete-during-iteration, delete/re-add, abrupt callback): host and
  standalone pass.
- Focused `tests/issue-4725.test.ts` and existing
  `tests/issue-2162-map-foreach.test.ts`: 8/8 pass.
- `pnpm run typecheck:ts5`, `pnpm run typecheck:ts7`, `pnpm run lint`,
  `pnpm run format:check`, `pnpm run check:oracle-ratchet`, and
  `pnpm run check:coercion-sites`: pass.

## Scope guard

Only the shared native collection forEach callback-dispatch site is in scope;
unrelated Map callback-parameter representation failures remain separate.
