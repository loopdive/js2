---
id: 6469
title: "function-local `var x = 0; x ||= obj` — the mixed-assignment carrier indexes only `=`, so logical assignments never widen the slot"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: correctness
---

## Problem

`scopeCarrierFacts` (`src/codegen/analysis/mixed-assignment-carrier.ts` ~L87)
walks assignment expressions looking for writes that outgrow a local's
specialized slot, but it matches **only `EqualsToken`**. The three logical
assignment operators — `||=`, `??=`, `&&=` — store into their left operand just
as `=` does, and are invisible to it. A function-local binding whose initializer
picked a numeric slot therefore keeps that slot across a logical rebind to an
object, and the store truncates.

This is the **function-local twin** of
[#6434](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6434-module-var-void-0-rebound-to-object),
which fixed the same blind spot on the MODULE-scope side. #6434 changed
`src/ir/heterogeneous-module-bindings.ts` (the collector direct codegen and the
IR resolver share) to index all four operators; the local-carrier analysis was
explicitly left out of that change's scope and is untouched.

## Reproduce (unverified — this issue is a reading of the code, not a measured failure)

The #6434 work found the `=`-only match by inspection while fixing the module
path; it did **not** build a local-scope fixture. So the first step here is a
probe, and "the local path already handles this by some other route" is a
legitimate outcome that closes the issue as `wont-fix` with the measurement.

Shape to probe, inside a function body rather than at module scope:

```js
function f(useObject) {
  var slot = 0;
  if (useObject) slot ||= { kind: "ctx-6469" };
  return slot ? slot.kind : "null";
}
```

Compare against the `=` form (`if (useObject && !slot) slot = {...}`), which the
carrier does index, and against a module-scope copy of the same shape, which
#6434 now handles. Assert the emitted local's Wasm type as well as the returned
string — a value-only assertion cannot tell "widened correctly" from "the
optimizer happened to hide it".

## Acceptance criteria

1. A probe that establishes whether the function-local `||=` / `??=` / `&&=`
   rebind actually mis-types the slot. If it does not, close `wont-fix` with the
   probe output rather than changing code.
2. If it does: index the three logical operators in `scopeCarrierFacts` the way
   #6434 did for the module collector, with a narrowness control proving a local
   that is never rebound keeps its specialized slot.
3. Regression test red on the parent, green with the fix, plus an anti-vacuity
   control that passes on both arms.
4. Dogfood A/B over the 17 upstream suites and a scoped test262 A/B. #6434's
   module-side change measured byte-identical on both, so any movement here is
   a real finding and needs explaining before it ships.

## Notes

Scope discipline from #6434 applies: widen on the ASSIGNMENT, never on the
initializer shape alone. #6434's module fix admits a `void 0` initializer as a
widening *candidate* and still leaves a never-rebound `void 0` on its i32 slot;
the same split is what keeps the change from costing representation on hot
numeric locals.
