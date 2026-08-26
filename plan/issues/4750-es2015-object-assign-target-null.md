---
id: 4750
title: "ES2015 standalone Object.assign throws on nullish target"
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: medium
horizon: s
feasibility: easy
task_type: conformance
area: codegen, object-runtime
es_edition: es6
goal: standalone-mode
related: [965, 1472, 2076]
loc-budget-allow:
  - src/codegen/object-runtime-enumeration.ts
func-budget-allow:
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers

---

# #4750 — standalone Object.assign nullish target

## Scope and measured baseline

The implementation branch is based on upstream `main` at
`73d090d7251f8b49287e7051fce15dc44931d6dc`; the pinned Test262 submodule is
`b363f29d3c43c626dc852744ad64a0b48a003693`.  The exact target test
`test/built-ins/Object/assign/Target-Null.js` reproduces as:

| lane | result | evidence |
| --- | --- | --- |
| JS-host | pass | `runTest262File(..., "issue-4750")`, wasm `195e2d7a7037` |
| standalone | fail | no TypeError thrown, wasm `83871d72f814` |

The tightly shared nullish control,
`test/built-ins/Object/assign/Target-Undefined.js`, has the same host pass /
standalone fail result (standalone wasm `dca057102fc0`).  A native-object
control, `Target-Object.js`, passes in both lanes.  Primitive boxing controls
(`Target-Boolean.js`, `Target-Number.js`, `Target-String.js`, and
`Target-Symbol.js`) expose broader standalone wrapper gaps and are deliberately
not included in this issue's root-cause claim.

## Root cause hypothesis

The native standalone `__object_assign` helper in
`src/codegen/object-runtime-enumeration.ts` copies enumerable source entries
and returns its target without applying §20.1.2.1 step 1 (`ToObject(target)`).
Its target parameter is an `externref`, so a null target reaches the helper and
is returned instead of throwing; under the undefined-singleton regime, an
undefined target is also non-null and is returned because no nullish predicate
is consulted.  The host implementation delegates to JavaScript's
`Object.assign`, so host behavior is already correct.

## Implementation plan

1. Add the narrow §20.1.2.1 step-1 nullish guard at the start of the native
   `__object_assign` helper.  Reuse the existing native nullish predicate when
   the undefined singleton is active, and emit a catchable `TypeError` using the
   object-runtime error-constructor path.
2. Add exact host and standalone pins for `Target-Null.js` and
   `Target-Undefined.js`, with `Target-Object.js` and a source-null control as
   positive controls.  Keep primitive wrapper residuals out of this fix.
3. Run focused Vitest/compiler gates, merge the latest upstream `main` without
   rebasing, and rerun all pins.  The clean branch tip is handed to the root
   agent for the combined upstream PR; this slice does not open an individual
   PR.

## Acceptance

- `Target-Null.js` and `Target-Undefined.js` pass in both host and standalone
  lanes through the exact `runTest262File` seam.
- `Target-Object.js` and a nullish-source control remain passing in both lanes.
- The implementation remains limited to the standalone object-runtime helper;
  primitive boxing and unrelated Object.assign source semantics are non-goals.

## Test Results

`/Users/thomas/Code/js2/node_modules/.bin/vitest run tests/issue-4750.test.ts
--reporter=verbose` — 8/8 passed (host + standalone for each of
`Target-Null.js`, `Target-Undefined.js`, `Target-Object.js`, and
`Source-Null-Undefined.js`).

The focused standalone pins now throw and catch the native TypeError for both
nullish targets; the object-target and nullish-source controls remain passing.

## Intended files

- `src/codegen/object-runtime-enumeration.ts`
- `tests/issue-4750.test.ts`
- this issue record
