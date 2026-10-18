---
id: 7059
title: "standalone: `strings.filter(Boolean)` answers `[]` — a builtin callback over reference elements falls to a null result instead of a host-free dispatch (host lane fixed by #5319); in hono's harness context the same chain traps, so `utils/concurrent` never initialises"
status: done
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
sprint: current
created: 2026-10-17
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: arrays, higher-order-functions
goal: standalone-gap
related: [7019, 5319, 3015]
loc-budget-allow:
  # 2026-10-18 (#7059/#7078) array-methods.ts +20: the standalone externref
  #   admission in `refElemHofCallbackIsClosure` (#7059, +9) and the i64 element
  #   arm of `compileArrayJoinNative` (#7078, +11) — both sit inside the two
  #   functions they change; no new subsystem.
  - src/codegen/array-methods.ts
import-cycles-allow:
  - largestSccSize: 716 # 2026-10-18 (#7060/#7061/#7080/#7081/#7084): five of the six new leaf modules are called from SCC members (calls-closures, property-access-dispatch, call-identifier, dyn-array-producers, operator-assignment) and reuse shared.js / object-runtime helpers that are already in the SCC; extracting them keeps the god-files from growing
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

## Original plan sketch (wave 16)

Host-free, when the callback is the unshadowed global `Boolean` (and, for
`map`, `String`/`Number`), lower the callback inline as the corresponding
abstract operation on the element (ToBoolean / ToString / ToNumber) instead of
routing it through a closure cast; otherwise route a non-closure callback
through the native generic callable invoke rather than producing null.
Measure hono `utils/concurrent` and the test262 `Array/prototype/{filter,map,
some,every,find}` slices base vs fix.

## Implementation Plan

Measured first: `compileArrayFilter` was never reached. For a REF-element
receiver (`string[]` is a vec of native-string refs standalone) the HOF gate
`hofElemKindOk` admits the receiver only when `refElemHofCallbackIsClosure`
proves the callback compiles to a GC closure struct. `Boolean` compiles to an
opaque `externref`, so the gate declined and the call fell to a generic
fallback that evaluated receiver + callee and answered `null` (`[]`).

`setupArrayCallback` already recovers a native `call_ref` for an externref
callback on standalone (#3015 signature wrapper, #6690 `__apply_closure`
fallback) — that path is exactly why `xs: any` (externref elements) worked.
So: admit `probed.kind === "externref"` in `refElemHofCallbackIsClosure` when
`ctx.standalone` (the same lane gate as the #3015 branch). The host lane keeps
its gate (the host bridge has no lowering for a GC-struct element).

## Resolution

`src/codegen/array-methods.ts` `refElemHofCallbackIsClosure`: a standalone
externref callback is admitted. `filter/some/every/find/findIndex/reduce(cb)`
over reference elements now run for `Boolean`, a `var`-bound function, an
object member and a cross-module import.

Measured (standalone): `["a","","b"].filter(Boolean).length` 0 → 2; hono
`utils/concurrent` now initialises (6 tests move from "module init null deref"
to assertion results; they still fail on the #6996 await-ordering gap).
Regression: `tests/issue-7059-hono-standalone-residuals.test.ts`.
