---
id: 2976
title: "Capture-carrying nested function declaration materializes a FRESH closure per reference — F === F is false; statics/sidecar writes land on dead instances"
status: ready
created: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: closures, function-identity
goal: spec-completeness
related: [2671, 2623, 2931, 2826]
depends_on: []
---

# #2976 — capturing nested fn decl: fresh closure struct per reference

## Problem (measured, minimal repro)

A nested `function` declaration that CAPTURES an outer variable is
re-materialized as a **fresh closure struct at every identifier reference**,
instead of being allocated once per enclosing-scope activation:

```ts
export function test() {
  var callCount = 0;
  function Constructor(executor) {
    function resolve(values) {
      callCount += 1; // capture → Constructor becomes capture-carrying
    }
    executor(resolve, function () {});
  }
  Constructor.resolve = function (v) {
    return v;
  };
  return "" + (Constructor === Constructor); // "false"  (spec: true)
}
```

Measured on main (2026-07-02, host mode): `Constructor === Constructor` →
**false**; two consecutive reads into locals compare unequal. A CAPTURE-FREE
nested declaration keeps stable identity (compare: the same shape with an
empty `resolve` body is identity-stable and its statics work).

## Consequences

1. **`===` self-identity broken** for any capture-carrying nested function.
2. **Static property writes land on a dead instance**: `Constructor.resolve =
fn` writes the sidecar of closure-instance #1; a later reference (e.g.
   `Promise.all.call(Constructor, …)`) passes instance #2 whose sidecar is
   empty → V8 rejects with `TypeError: resolve is not a function`.
3. This is the root cause of **~10 files of the #2671 Promise capability
   bucket** (`call-resolve-element*`, `resolve-before-loop-exit*`,
   `resolve-from-same-thenable*` — every variant whose `Constructor` declares
   a capturing inner `resolve`/`reject`), left failing by the #2671 capability
   slice (which fixed the sibling top-level/capture-free shapes).
4. Weak-keyed host caches (`_hostCallableCache`, `_wasmClosureDynamicWrapperCache`,
   `_hostProxyCache`) key per closure INSTANCE, so wrappers/proxies also fork
   per reference — host-side identity (`assert.sameValue(fn1, fn2)`) breaks
   even when wrapped.

## Direction

The closure for a hoisted nested function declaration should be materialized
ONCE per enclosing activation (hoisted alongside the declaration, stored in a
local/ref-cell) and every identifier reference should read that slot — the
same discipline module-level closures already follow. Interacts with the
capture ref-cell machinery and possibly #2931 (live bindings for reassigned
function decls) — an architect pass is warranted before implementation
(`feasibility: hard`).

## Acceptance

- `F === F` is true for a capture-carrying nested function declaration.
- Static-property writes on such an F are visible through every later
  reference (wasm-side reads AND the host live-mirror).
- The #2671 capability sub-bucket flips: `built-ins/Promise/*/
call-resolve-element*.js`, `*/resolve-before-loop-exit*.js`,
  `*/resolve-from-same-thenable.js` (measure exact list against the
  then-current baseline).
- No test262 regressions.
