---
id: 4727
title: "ES2015 standalone Promise.resolve custom-constructor self-resolution"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, promises
es_edition: es2015
language_feature: promise-resolve
goal: spec-completeness
related: [4682]
source_cap: 180
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/promise-combinators.ts
  - tests/issue-4727.test.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #4727 — Promise.resolve custom-constructor self-resolution

## Scope

This issue owns the bounded standalone `Promise.resolve.call(C, value)` path
when `C` is an ordinary compiled constructor and its capability resolver is
used to resolve the constructed promise.  The exact residual is
`built-ins/Promise/resolve/resolve-self.js`; focused identity, non-thenable,
thenable, and native self-resolution controls cover the same Promise.resolve
admission and resolver protocol.  It does not widen into the general custom
constructor/subclass Promise capability family, poisoned constructors, or the
separate direct `Promise.resolve(promiseWithCustomThen)` value path.

## Live baseline

The authoritative JSONL snapshots were refreshed with `--force` on 2026-08-25
from `upstream/main` `21d7d893d` (oracle version 13):

| Test262 row | Host baseline | Standalone baseline |
| --- | --- | --- |
| `built-ins/Promise/resolve/resolve-self.js` | pass | fail — `TypeError: Promise.resolve is not yet implemented in --target standalone` |
| `built-ins/Promise/resolve/ctx-ctor.js` | pass | fail — same not-implemented error |
| `built-ins/Promise/resolve/resolve-from-promise-capability.js` | pass | fail — same not-implemented error |
| `built-ins/Promise/resolve/resolve-thenable.js` | fail — promise settles with the wrong value | pass |
| `built-ins/Promise/resolve/resolve-prms-cstm-then.js` | pass | fail — expected the provided promise/value identity |
| `built-ins/Promise/resolve/capability-executor-called-twice.js` | pass | fail — same not-implemented error |

Fresh `runTest262File` probes in this worktree reproduce the table in the
normal assembled host and standalone harnesses.  The positive standalone
`resolve-thenable.js` control demonstrates that the native direct resolve
lowering already assimilates an ordinary thenable; the host thenable failure
and the standalone custom-`then` failure are separate pre-existing defects.

## Root cause

Direct standalone `Promise.resolve(value)` is lowered in
`src/codegen/expressions/call-namespace-static.ts` through
`emitStandalonePromiseResolve`.  A first-class read of `Promise.resolve`,
however, is created by `ensureStandaloneBuiltinStaticMethodClosure` in
`src/codegen/builtin-value-read.ts`, whose static-method metadata has no
Promise.resolve entry and therefore emits the generic “not yet implemented”
closure.  Reflective `Promise.resolve.call(C, value)` consequently never
enters the native PromiseResolve/`NewPromiseCapability(C)` protocol.  The
existing standalone custom-capability runtime in `promise-combinators.ts`
already validates the resolve/reject functions for empty combinators, but it
does not retain the constructed promise or invoke the captured resolver with
the requested value.  That missing admission and resolver hand-off is the
shared root cause of the bounded custom-constructor rows.

## Implementation plan

1. Add a narrow standalone `Promise.resolve.call(C, value)` admission before
   the generic reflective call path.  Preserve left-to-right evaluation and
   the ordinary intrinsic `Promise.resolve` direct path.
2. Reuse the existing custom-capability executor machinery to construct `C`,
   retain its returned promise, validate callable resolve/reject captures, and
   invoke the captured resolve through the native standalone promise-resolve
   routine.  Self-resolution must therefore reject with `TypeError`, while
   identity and thenable controls retain their specified behavior.
3. Add focused regression coverage and rerun the exact official rows and
   controls in both host and standalone modes.  Keep compiler source changes
   within the 180-line cap and leave unrelated Promise capability/subclass
   residuals unchanged.
4. Run the required TS5/TS7, typecheck, lint, format, focused test, and
   prepush checks before merging the latest `upstream/main` into the branch.

## Test Results

Focused regression (`tests/issue-4727.test.ts`): 2/2 passed.  The standalone
self-resolution case preserves constructor-result identity and observes the
required asynchronous TypeError rejection; the ordinary-value and thenable
case checks both resolver inputs.

Exact `runTest262File` probes after the fix, with the host lane and standalone
lane run separately, report:

| Test262 row | Host | Standalone |
| --- | --- | --- |
| `resolve-self.js` | pass | pass |
| `resolve-non-thenable.js` | pass | pass |
| `resolve-thenable.js` | fail — existing wrong fulfillment value | pass |
| `S25.4.4.5_A2.1_T1.js` | pass | pass |
| `S25.4.4.5_A2.3_T1.js` | pass | pass |

The pre-existing `resolve-from-promise-capability.js` residual remains host
pass / standalone fail (`callCount` is observed as `1` before the custom
constructor returns).  It exercises the broader direct promise-capability
constructor path and is recorded as evidence, not expanded into this bounded
change.

Quality gates: TS5 typecheck pass; TS7/typecheck pass; Biome lint pass;
Prettier format check pass; LOC/function budgets, oracle ratchet, and
coercion-site ratchet pass. Production source growth is +174 net lines, below
the 180-line cap. The publication push runs the repository pre-push hook.

## Acceptance / non-goals

- `resolve-self.js` passes in standalone and remains passing in host mode.
- The selected identity/non-thenable/thenable controls pass in standalone;
  existing host/direct controls do not regress.
- No broad Promise combinator, subclass, or resolver-element-function rewrite.
- Source delta remains ≤180 lines, with issue evidence and test results kept in
  this file.
