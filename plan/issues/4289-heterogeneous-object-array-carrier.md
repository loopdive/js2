---
id: 4289
title: "Array literal: a later anonymous-object shape is null-cast to the first element's struct"
status: done
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays, object-literals
goal: npm-library-support
sprint: 78
required_by: [1400]
es_edition: ES2015
related: [786, 1021, 2021, 3244]
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
---

# #4289 — heterogeneous anonymous-object arrays use an unsound closed carrier

## Problem

The real ESLint 10.0.3 upstream test file
`tests/lib/shared/deep-merge-arrays.js` contains 44 table cases. Compiling those
original case bodies into Wasm reaches a deterministic runtime trap when case
37 is added:

```js
const rows = [{ a: { b: "c" } }, { d: true }];
```

The module compiles successfully and `WebAssembly.validate` returns true, but
instantiation traps with `dereferencing a null pointer` in `__module_init`.
The 36-case prefix instantiates; the 37-case prefix does not. The individual
case reduces to the two-element literal above, so this is not a test-runner or
full-ESLint-graph failure.

## Root cause

`compileArrayLiteral` derives its element carrier from the first significant
element. Here that is the closed struct for `{ a: { b: string } }`, so the vec
uses an array of that exact struct ref. The second element is the distinct
closed struct for `{ d: boolean }`.

The emitted WAT performs a guarded cast of the second struct to the first:

```wat
struct.new $second_shape
ref.test (ref $first_shape)
if (result (ref null $first_shape))
  ...
else
  ref.null $first_shape
end
ref.as_non_null
```

The cast correctly fails, then `ref.as_non_null` makes the compiler's bad
carrier choice observable as a trap. The existing #2021 widening only applies
when a contextual `Array<T>` declares a common struct; an unannotated union of
anonymous shapes has no such context.

## Acceptance criteria

- A reduced root test is red on the unfixed compiler and constructs the exact
  nested-object/sibling-shape literal.
- Heterogeneous object-ref elements use a lossless carrier instead of a closed
  struct that later elements cannot inhabit.
- Both objects remain readable after construction; merely avoiding the trap by
  dropping or nulling a value is not sufficient.
- Homogeneous anonymous-object arrays remain runnable.
- All 44 original ESLint upstream deep-merge cases instantiate and execute
  inside Wasm, with their results compared against the same cases in Node.
- The exact ESLint npm-compat package-entry and `Linter.verify` workload probes
  are re-run; this slice need not solve their separate whole-graph compile-time
  budget.

## Baseline measurement

On integration base `1d260d48a0d01c`:

- `pnpm run dogfood:eslint`: compile timeout at **180,060 ms**, no binary.
- `pnpm run dogfood:eslint-workload`: compile timeout at **180,047 ms**, no
  runtime attempt.
- upstream deep-merge table: prefixes **1, 8, 16, 24, 32** instantiate; prefix
  **37** and every measured longer prefix trap. The table contains **44** cases.

These are three separate facts: the package graph is currently too slow for its
catalog budget, while the small upstream unit has an independently reduced
wrong-code bug that reaches valid Wasm and then traps.

## Resolution

`compileArrayLiteral` now proves whether object-literal elements have the same
statically known own data-property set before selecting element zero's closed
struct as the array carrier. Without a contextual `Array<T>` common carrier,
different or unknowable field sets select the canonical externref vec instead.
Each element is stored losslessly in its own representation; no guarded
cross-struct downcast is emitted.

The gate is deliberately narrow:

- only no-spread literals whose first significant element is an object literal;
- homogeneous static field sets retain the closed carrier;
- a contextual ref-typed `Array<T>` retains its declared common carrier;
- methods, accessors, spreads, and dynamic computed keys fail closed to the
  lossless carrier rather than claiming structural compatibility.

## Verification

- `tests/issue-4289-heterogeneous-object-array-carrier.test.ts`: **3/3 pass**.
  On the unfixed base, the two heterogeneous cases trap in `__module_init` and
  the homogeneous control passes, proving the regression is non-vacuous.
- Original ESLint `deep-merge-arrays` table: the full **44/44 cases now
  instantiate and run**. Wasm matches **37/44**; Node matches **44/44**. The
  seven executed semantic mismatches are follow-up defects, not skipped tests
  and not part of this carrier-construction fix.
- The exact package-entry and `Linter.verify` probes remain separately bounded
  at 180 seconds; both time out before emission as recorded above.
