---
id: 3435
title: "new TA() on a JSDoc Function-typed callback param falls to the __new_TA extern import — TypedArray harness wall"
status: done
created: 2026-07-18
completed: 2026-07-18
assignee: ttraenkler/fable-5
priority: high
feasibility: medium
task_type: bugfix
area: codegen-new
goal: test262-conformance
model: fable
sprint: current
horizon: s
related: [3432, 3419, 3087, 3074]
# Site-required: the builtin:Function acceptance + rationale live inside the
# resolvesToDynamicAnyCtorValue gate (mostly comment lines citing the JSDoc
# contextual-typing root cause).
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
---

# #3435 — `Function`-typed dynamic ctor params miss the #3087 `__construct_closure` route

## Problem

Post-#3419/#3432, the dominant residual of the TypedArray harness bucket
(10/40 of the deterministic sample) was:

```
Error: No dependency provided for extern class "TA" (Testing with Float64Array and makeArray.)
```

`testWithTypedArrayConstructors(function (TA) { new TA(3); … })` — the callback
runs with a real host constructor in `TA`, but `new TA(3)` compiled to the
non-existent `env.__new_TA` extern-class import.

## Root cause (verified 2026-07-18, fable-5 — oracle-fact trace)

The #3087 machinery for exactly this shape exists (`resolvesToDynamicAnyCtorValue`
→ `__construct_closure` bridge, both at the dynamic-fallback no-match base and
the S1 arm in `new-super.ts`) but gates on the callee's oracle fact being
`any`/`unknown`. Under `checkJs`, the harness JSDoc
(`@callback typedArrayConstructorCallback` / `@param {Function} TypedArrayConstructor`)
CONTEXTUALLY types the callback param as the lib `Function` interface, so the
oracle reports **`builtin:Function`** — the gate declined, and the unknown-ctor
fallthrough emitted the name-keyed `__new_TA` import. Trace confirmed the
context-dependence: `fact=any` inside the un-jsdoc'd harness helpers
(`makeArrayBuffer` — arm fired) vs `fact=builtin` inside the contextually-typed
callbacks (arm declined).

## Fix

`resolvesToDynamicAnyCtorValue` additionally accepts `builtin:Function`: the
bare lib `Function` interface has no static construct signature to dispatch on,
and the `__construct_closure` runtime side runs the spec IsConstructor probe
(`Reflect.construct(function(){}, [], value)`) — constructing real ctors and
throwing the spec TypeError for non-constructors — so the route is spec-correct
for ANY runtime value. Host lane only (gate call sites already `!noJsHost`).

## Verification

- Reduced probe (`new TA(3)` in a `testWithTypedArrayConstructors` callback,
  via the real include): fail → **pass**.
- Guard: `new f()` where `f` is a Function-typed param holding
  `Math.max.bind(null)` (non-constructor) still throws TypeError → pass.
- Guard suites `issue-3087` / `issue-3074` / `issue-2886` / `issue-1732-s1`:
  28/28 pass.
- 40-file deterministic bucket sample (stacked on #3419+#3432):
  **5 → 10 pass**; residuals are now fully heterogeneous TypedArray semantics
  (12+ distinct signatures — no single next lever in this bucket).

## Stacking

Branch stacked on `issue-3432-decl-closure-array-bind` (which stacks on
`issue-3419-dup-topfn-lastwins`) — the repro is unreachable without both.
Enqueue after the predecessors land.
