---
id: 7059
title: "standalone: `strings.filter(Boolean)` answers `[]` — a builtin callback over reference elements falls to a null result instead of a host-free dispatch (host lane fixed by #5319); in hono's harness context the same chain traps, so `utils/concurrent` never initialises"
status: ready
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: arrays, higher-order-functions
goal: standalone-gap
related: [7019, 5319, 3015]
---

# Builtin callbacks over reference elements are dropped standalone

Found while reducing [#7019](./7019-standalone-module-init-traps-cjs-graphs.md)
(hono `src/utils/concurrent.test.ts`, 6 tests: module init null deref).

## Repro (standalone, 2026-10-17)

```ts
export function t1(): number { return ["a", "", "b"].filter(Boolean).length; }          // 0, expected 2
export function t2(): number { return [1, 0, 2].filter(Boolean).length; }               // 2 (ok)
export function t3(): number { return ["a", "", "b"].filter((x) => Boolean(x)).length; } // 2 (ok)
export function t4(): number { const xs: any = ["a", "", "b"]; return xs.filter(Boolean).length; } // 2 (ok)
```

The emitted `t1` evaluates the receiver and the `Boolean` constructor object,
then returns `ref.null extern` as the filter result — the callback setup
declined and the call degraded to null. [#5319](./5319-hof-reference-element-bridge.md)
fixed the host lane with `__call_dyn_1`; `referenceElementBridgeName`
explicitly leaves host-free targets to `resolveDynamicCallbackClosure`
(#3015), which cannot cast the builtin constructor object to a closure wrapper.

In the upstream harness (`__upstreamTableRows`: `source.split(/\r?\n/).map(fn)
.filter(Boolean)`) the same chain traps with "dereferencing a null pointer" at
module init, which is what fails `utils/concurrent` (`test.each` tagged
template tables).

## Implementation Plan (sketch)

Host-free, when the callback is the unshadowed global `Boolean` (and, for
`map`, `String`/`Number`), lower the callback inline as the corresponding
abstract operation on the element (ToBoolean / ToString / ToNumber) instead of
routing it through a closure cast; otherwise route a non-closure callback
through the native generic callable invoke rather than producing null.
Measure hono `utils/concurrent` and the test262 `Array/prototype/{filter,map,
some,every,find}` slices base vs fix.
