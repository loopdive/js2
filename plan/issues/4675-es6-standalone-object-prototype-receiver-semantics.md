---
id: 4675
title: "ES2015 standalone: Object.prototype ordinary receiver/coercion residual"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
assignee: codex/es6-objectproto-wave3
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: es6
language_feature: object-prototype
goal: standalone-mode
related: [4444, 2175]
files:
  - src/codegen/object-runtime.ts
  - src/codegen/closures/result-boxing.ts
  - tests/issue-4675.test.ts
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
coercion-sites-allow:
  - src/codegen/object-runtime.ts
---

# #4675 — ES2015 standalone Object.prototype ordinary semantics

## Scope and plan

Own one bounded non-reflection cluster from the Object.prototype tail in the
ES2015 standalone edition. Built-in function metadata and reflection-only
failures remain with #2175 and are excluded. The two sibling
`symbol_property_toPrimitive.js` rows are also excluded: standalone
`Symbol.toPrimitive` lookup remains the deferred #1900/#1472 slice, while this
issue targets the ordinary `toString`/`valueOf` receiver-coercion path.

1. Measure the complete `built-ins/Object/prototype` set on fresh
   `upstream/main`, then classify failures by method, receiver shape, and
   error signature. Do not treat a shared error string as a root-cause bucket.
2. Select the four ordinary receiver/coercion rows (two `hasOwnProperty`, two
   `propertyIsEnumerable`) whose `toString`/`valueOf` returns a Symbol, with
   direct Symbol and primitive-key controls. Reproduce them with a minimal
   standalone probe and inspect the emitted lowering/runtime arm.
3. Preserve the native Symbol brand while a dynamically dispatched closure
   result crosses the externref ABI; teach native ToPropertyKey/ToPrimitive
   to preserve that Symbol rather than applying ToString. Add exact Test262
   regressions and record before/after rows plus zero-loss controls.

## Baseline measurement (fresh upstream `c5270b9d7`, 2026-08-25)

The standalone Object.prototype filter contained 248 executed rows: **189
pass, 50 fail, 9 compile errors, 0 skipped**. Edition generation showed the
ES2015 slice at 57 rows: **19 pass, 33 fail, 5 compile errors**, i.e. the
umbrella's **38 nonpassing ES2015 residuals**. The four in-scope rows were all
failures; the two `symbol_property_toPrimitive.js` siblings were failures but
were excluded because their missing Symbol-keyed exotic lookup belongs to
#1900/#1472.

The four in-scope rows shared a more specific root cause than the generic
`Cannot convert object to primitive value` text: `Symbol()` is lowered to a
branded native i32 id, but the generic `__call_fn_method_0` closure dispatcher
boxed every i32 result as a number when invoking an object `toString` or
`valueOf` dynamically. The resulting key was therefore numeric rather than a
Symbol. Even after fixing that ABI seam, `__to_property_key` had to recognize
the returned native `$Symbol` carrier as a primitive and preserve it without
calling ToString.

## Implementation and evidence

- `src/codegen/closures/result-boxing.ts` now checks the `symbol` i32 brand and
  calls native `__box_symbol` before the boolean/number branches.
- `src/codegen/object-runtime.ts` includes native Symbol in the
  OrdinaryToPrimitive primitive cascade and makes the non-Symbol
  ToPropertyKey arm run ToPrimitive first, preserving a resulting Symbol.
- `tests/issue-4675.test.ts` runs the four exact Test262 rows in the
  standalone lane. Before the fix: 0/4; after the fix: **4/4**.
- The untouched direct Symbol-key controls (`symbol_own_property.js` in both
  method directories) remain in the scoped zero-loss comparison; the full
  Object/prototype after-sweep passed them as well.

## Test Results

- Focused standalone regressions: **6/6 pass** (four exact receiver-coercion
  rows plus two direct Symbol-key controls).
- Fresh-upstream baseline full Object/prototype sweep:
  **248 rows — 189 pass, 50 fail, 9 compile errors, 0 skipped**.
- Rebuilt-bundle after-sweep: **248 rows — 192 pass, 47 fail, 9 compile
  errors, 0 skipped**. All four in-scope rows changed from fail to pass; the
  raw run also had one unrelated `isPrototypeOf/builtin.js` runtime-eval
  provider setup failure. Rebuilding the refusal provider and rerunning that
  row passed it, so there is no observed semantic loss outside this cluster.
- `git diff --check` and Prettier checks pass. A repository-wide `tsc --noEmit`
  check remains unavailable in this checkout because the pre-existing
  environment lacks Node type declarations.
