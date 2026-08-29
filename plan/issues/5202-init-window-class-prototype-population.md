---
id: 5202
title: Compiled class prototypes are empty during module init — the #5193 window's method/prototype facet blocks Temporal
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5202 — class prototypes unpopulated during the module-init window

## Problem

Fourth Temporal module-init blocker (#4628 Option A). With #5191 (merged),
#5193 (PR #5252) and #5201 (PR #5256) all applied, the jsbi receiver is now
CORRECT at the failing call (`[object Array]`, proto ctor `JSBI`, own keys
`0, sign`) — but `JSBI.prototype` carries only `constructor`, so
`_.__clzmsd()` still throws `__clzmsd is not a function`. `moduleInitRuns`
stays `false`.

## Mechanism (isolated by dev-5201)

Timing, not dispatch. Same source, same wiring, only the call's timing
differs:

```js
class D extends Array { constructor(n, s) { super(n); this.sign = s; }
                        __clzmsd() { return 7; } }
function f(a) { return a.__clzmsd(); }

const AT_INIT = f(new D(1, false));                     // THROWS
export function test() { return f(new D(1, false)); }   // returns 7
```

The host runtime populates a compiled class's prototype with its methods
only once it has the instance's exports, wired via
`result.importObject.__setInstance(instance)` — callable only AFTER
`WebAssembly.instantiate` returns. Top-level code runs in the wasm `start`
section, DURING instantiate, so every prototype is bare for the whole of
module init. This is the #5193 window again — its method/prototype facet
(#5193 fixed the marshalling-probe facet via the `__register_init_export`
funcref registry, PR #5252).

Corroborating detail from dev-5201: on the same binary,
`runtime.buildImports(...)` + explicit `setInstance` answers correctly for
the after-init shape while `result.importObject` alone throws.

## Direction

Extend the #5193 mechanism (src/runtime/init-marshal-registry.ts /
src/codegen/init-marshal-helpers.ts — `getStartExports()`): the prototype
population that `__setInstance` performs late should be doable from the
start-section prologue too, using the same funcref-registration channel
(method funcrefs registered before the class's first top-level use), or by
having `__register_class_*` calls at init time consult the start-exports
registry. Decide with evidence; keep the late `__setInstance` path intact
for the non-init case, and keep standalone/WASI untouched.

## Acceptance criteria

1. The reduced repro above: `AT_INIT === 7`, host lane, failing on base and
   passing with the fix (new tests/issue-5202-*.test.ts; include the
   after-init control).
2. The Temporal harness advances past `__clzmsd`
   (`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs`, run on
   a tree containing #5252 + #5256 + this). If a NEW later blocker appears,
   file it (coordinator allocates ids when the scan is degraded) and record
   it. If `moduleInitRuns` flips `true`, say so LOUDLY — that un-gates
   #4628's integration step.
3. No regressions in the #5193 test file, the #5201 test file, and scoped
   class/method runs (name them). Ratchet gates green.

## Notes

- Blocker chain: #5191 (class value null) → #5193 (init marshalling window)
  → #5201 (lossy vec representation) → this.
- Prerequisites: PR #5252 and PR #5256 should be on main before this lands
  (the harness measurement depends on both); the reduced repro itself may
  reproduce on plain main.
- Id #5202 reserved with a degraded PR scan (gh offline); manually verified
  against all open PR head branches on 2026-08-29 (the one grep hit for
  "5202" is the long-merged PR #5202's deno branch, not an issue file). The
  `check:issue-ids:against-main` gate arbitrates.
