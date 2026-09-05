---
id: 4746
title: "ES2015 Promise constructor property order"
status: done
sprint: current
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: promises, builtins, conformance
es_edition: es2015
language_feature: Promise-constructor
goal: test262-conformance
source_loc_cap: 120
related: [2671, 2739]
---

# #4746 — ES2015 Promise constructor property order

## Scope

This issue owns the exact ES2015 Test262 row
`test/built-ins/Promise/property-order.js`. The row checks that the Promise
constructor's own `length` property precedes its own `name` property in
`Object.getOwnPropertyNames(Promise)`. The fix must preserve the existing
Promise constructor behavior and the property order of unrelated built-ins.

The initial baseline and emitted-Wasm inspection will establish whether the
failure is in the standalone Promise constructor's static property
registration, the generic own-property ordering path, or the test harness.
The implementation will be wired at the narrowest confirmed site. Host and
standalone Promise behavior are both in scope; unrelated Promise instance,
combinator, subclass, and asynchronous scheduling residuals are excluded.

## Baseline

Measured on upstream/main commit `9efc8e766` with fresh Node processes for
each row. The exact target passes in host but fails in standalone with the
Test262 assertion. A direct numeric probe showed the host Promise has
`length` at index 0 and `name` at index 1, while standalone Promise has no
own properties at all (`Object.getOwnPropertyNames(Promise).length === 0`).
The host controls all pass. Standalone Object property order passes; the
standalone Function control reaches a pre-existing illegal-cast failure, and
the standalone Promise resolve/reject-function controls fail their own
`length`/`name` assertions. The standalone measurements used the local
interpreter refusal provider because the QuickJS artifact is not available in
this environment; the target itself is independent of dynamic evaluation.

| Test262 row | Host | Standalone |
| --- | --- | --- |
| `built-ins/Promise/property-order.js` (exact target) | pass | **fail** — `Promise` carrier has zero own properties |
| `built-ins/Function/property-order.js` (control) | pass | fail — pre-existing illegal cast in `__module_init` |
| `built-ins/Object/property-order.js` (control) | pass | pass |
| `built-ins/Promise/resolve-function-property-order.js` (control) | pass | fail — callback function property order |
| `built-ins/Promise/reject-function-property-order.js` (control) | pass | fail — callback function property order |

## Bounded implementation plan

1. Reproduce the exact row on the upstream/main worktree in both lanes and
   confirm the issue is not already fixed or silently skipped. Capture the
   expected native order and the compiler's returned order/error.
2. Trace the Promise constructor creation and own-property enumeration path.
   The current standalone constructor identity set omits `Promise`, so its
   bare value falls through without the existing constructor carrier and
   `pushBuiltinCtorOwnPropSeed` cannot install `length`/`name`/`prototype`.
3. Add `Promise` to the existing standalone constructor-identity set. Reuse
   the established carrier seeding path, which installs the spec's
   non-enumerable `length`, `name`, and native-prototype properties in order;
   do not broaden generic object enumeration or callback-function metadata.
   Add an explicit regression test under `tests/issue-4746.test.ts` that drives
   the exact row through host and standalone execution, plus the Object
   property-order control and a direct carrier probe.
4. Rerun the exact row, controls, and focused regression test in fresh
   processes. Check the changed-file format/lint/type gates and source/function
   budgets, then merge the latest upstream/main without rebasing and rerun the
   focused checks.

## Acceptance

- `built-ins/Promise/property-order.js` passes in host and standalone lanes.
- The Promise constructor still exposes the same own properties and values,
  with `length` immediately before `name`.
- The selected Function/Object property-order controls remain unchanged.
- The patch stays within the stated source budget and does not alter generic
  property enumeration, Promise instance settlement, combinators, or subclass
  behavior.

## Test Results

Baseline (upstream/main `9efc8e766`):

```
exact Promise/property-order: host pass; standalone fail (Promise had zero own properties)
Function/property-order control: host pass; standalone pre-existing illegal cast
Object/property-order control: host pass; standalone pass
Promise resolve/reject-function-property-order controls: host pass; standalone fail (callback metadata residual)
```

Post-fix (after fast-forward merge of upstream/main `ed7ecba7c`):

```
direct Promise constructor index probe (length index * 100 + name index): host 1; standalone 1
exact Promise/property-order: host pass; standalone pass
Object/property-order control: host pass; standalone pass
focused tests/issue-4746.test.ts: 4/4 pass
```

The standalone checks use the local interpreter refusal provider because the
QuickJS artifact is unavailable in this environment; this row does not invoke
dynamic evaluation. The Promise resolve/reject callback metadata residual is
intentionally outside this constructor-carrier slice.
