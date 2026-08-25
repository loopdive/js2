---
id: 4735
title: "ES2015 standalone Promise.resolve preserves a Promise instance's overridden then"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, promises
es_edition: es2015
language_feature: promise-resolve
goal: test262-conformance
source_cap: 180
# Depends on #4951 (the implementation head is 09e5201a5; no canonical
# plan/issues/4951 record exists in the merged upstream tree).
depends_on: []
related: [4727, 4734, 4951]
loc-budget-allow:
  - src/codegen/async-scheduler.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/promise-executor.ts
  - src/codegen/async-frame.ts
  - src/codegen/promise-combinators.ts
func-budget-allow:
  - src/codegen/async-scheduler.ts::emitStandalonePromiseResolve
  - src/codegen/expressions/call-receiver-method.ts::compileCallReceiverMethod
---

# #4735 — standalone Promise.resolve with an overridden `then`

## Scope

This issue owns the standalone residual in the exact Test262 row
`built-ins/Promise/resolve/resolve-prms-cstm-then.js`. A native `$Promise`
instance receives an own callable `then` override, and `Promise.resolve`
must preserve that instance identity so the later `.then(...)` call observes
the override. The fix is limited to the native Promise instance's own `then`
storage/read/invocation path and its initialization at native Promise creation
sites.

This child starts from #4951 head `09e5201a5` and **Depends on #4951** (the
custom-constructor self-resolution implementation). It does not change
self-resolution (#4727/#4951), direct promise-capability construction
(#4734), Promise combinators, subclass receivers, host Promise behavior, or
the general dynamic property substrate.

## Measured baseline

Baseline was measured on `09e5201a56738fd13a1eca131730a61be2b1b2db` with the
assembled `runTest262File` harness and pinned Test262 checkout. Each lane was
run in a fresh Node process; `standalone` means `runTest262File(...,
"standalone")` with no host imports.

| Test262 row | Host | Standalone |
| --- | --- | --- |
| `built-ins/Promise/resolve/resolve-prms-cstm-then.js` (exact target) | pass | **fail** — `resolvedValue` is `undefined`, expected the object passed by the overridden `then` |
| `built-ins/Promise/resolve/resolve-non-thenable.js` (non-thenable control) | pass | pass |
| `built-ins/Promise/resolve/resolve-thenable.js` (ordinary thenable control) | **fail** — pre-existing host wrong-value residual | pass |
| `built-ins/Promise/resolve/S25.4.4.5_A2.1_T1.js` (same-constructor identity control) | pass | pass |
| `built-ins/Promise/resolve/S25.4.4.5_A2.3_T1.js` (unsettled same-constructor identity control) | pass | pass |

The exact standalone failure is a real assertion failure, not a compile or
host-import refusal. The standalone controls show that #4951's native
PromiseResolve/thenable machinery already handles ordinary values, ordinary
thenables, and native Promise identity; only the own-`then` override is lost.

## Root-cause hypothesis

`emitStandalonePromiseResolve` correctly returns a native `$Promise` unchanged
for a native Promise argument. The subsequent statically typed `.then` call is
lowered directly by `compileCallReceiverMethod` to the native `$Promise` chain,
which reads state/value/callbacks and never performs ordinary `Get(p,
"then")`. The `$Promise` carrier has no own-`then` slot, so the assignment
cannot be observed by a later call; the native prototype path therefore sees
the original fulfilled `undefined` value instead of invoking the override.

## Bounded implementation plan

1. Add one nullable externref own-`then` slot to the native `$Promise` carrier
   and initialize it to null at every native Promise construction site. Keep
   state/value/callback layout and all host/GC Promise paths unchanged.
2. Route the narrow standalone `Promise` instance property assignment
   `p.then = callable` through the existing closed-struct setter dispatcher,
   which now sees the carrier slot, preserving the existing externref
   callable representation and assignment result. Do not generalize this to
   arbitrary Promise expandos or change #4734 capability semantics.
3. At native `.then(...)` call sites, test the slot before the native chain;
   when populated, invoke the stored callable with the original receiver and
   source argument vector through the existing closure bridge. A null slot
   keeps the current native chain byte/behavior path. The exact target's
   second rejection callback remains an ordinary source argument and is not
   consumed by the one-argument override.
4. Add focused equivalence coverage for the exact override/identity behavior,
   then rerun the exact host+standalone row and the four minimal controls in
   both lanes. Keep production source growth at or below 180 net lines and
   leave combinators, subclasses, #4727 self-resolution, and #4734 outside the
   diff.
5. Run the required TS5/TS7 typechecks, focused tests, lint, format, budget
   and hook checks after merging the latest upstream without rebasing.

## Acceptance

- The exact `resolve-prms-cstm-then.js` row passes in standalone and remains
  host-pass.
- The four named controls remain unchanged in both lanes (the host
  `resolve-thenable.js` residual is recorded, not expanded).
- Own `then` assignment on native `$Promise` is preserved and invoked with
  correct receiver/arguments; a null slot follows the existing native chain.
- No self-resolution, custom-capability, combinator, subclass, host-path, or
  general expando changes are introduced.
- Changed production source remains ≤180 net lines.

## Test Results

Baseline (commit `09e5201a5`):

```
exact target: host pass; standalone fail (undefined vs overridden-then object)
non-thenable control: host pass; standalone pass
ordinary thenable control: host fail (pre-existing); standalone pass
same-constructor identity controls: host 2/2 pass; standalone 2/2 pass
```

Post-fix (child branch, exact target and controls):

```
exact target: host pass (SHA 37ddb5cbf27b); standalone pass (SHA c778d5dafda3)
non-thenable control: host pass (SHA 60848ce6f601); standalone pass (SHA 6d4cf39a9640)
ordinary thenable control: host fail (pre-existing wrong-value residual); standalone pass (SHA 6271bd3e21af)
same-constructor identity controls: host 2/2 pass; standalone 2/2 pass
focused Vitest tests/issue-4735.test.ts: 2/2 pass
focused Vitest issue-4727 + issue-4735: 4/4 pass
```

Quality gates:

```
TypeScript 5 and TypeScript 7: pass
Biome lint (changed files): pass
Prettier check (changed files): pass
LOC budget: pass; function budget: pass
Native-first host-import policy: pass (393/393 maximum)
git diff --check: pass; core.hooksPath=.husky with executable pre-commit/pre-push
```

The child adds 111 production lines and removes 10 (net +101), below the
180-line cap. The host `resolve-thenable.js` failure remains the measured
pre-existing residual and is intentionally outside this child.
