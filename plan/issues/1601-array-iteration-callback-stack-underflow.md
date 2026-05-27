---
id: 1601
title: "codegen: Array.prototype reduce/reduceRight/map/filter callback paths emit invalid wasm (stack underflow at local.set/if/array.set)"
status: done
created: 2026-05-24
updated: 2026-05-27
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: array-iteration-methods
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 156
related: [1522]
---
# #1601 — Array iteration methods emit stack-underflow wasm in callback path

## Problem

156 test262 tests fail with `invalid Wasm binary` where the Binaryen validator
reports a **stack underflow** inside the compiled `test` (or `__closure_N`)
function for an `Array.prototype` iteration method:

```
not enough arguments on the stack for local.set (need 1, got 0)
not enough arguments on the stack for if (need 1, got 0)
not enough arguments on the stack for array.set (need 3, got 2)
```

All 156 are `built-ins/Array` and concentrate on the callback-driven
iteration methods:

| method      | CE count |
|-------------|----------|
| reduce      | 62 |
| reduceRight | 57 |
| map         | 13 |
| filter      | 11 |
| findIndex   | 6 |
| find        | 6 |
| some        | 1 |

This is distinct from the generic type-boundary umbrella #1522 (which lists
only ~2 of each shape). The dominant cause here is the
**reduce/reduceRight accumulator path** and the **map/filter store path**
when the callback or species constructor is observed (e.g.
`create-species-undef`, getter-observing length, predicate-call tests).

## Failing test examples

- `test/built-ins/Array/prototype/reduce/15.4.4.21-8-b-iii-1-33.js`
- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-9-b-16.js`
- `test/built-ins/Array/prototype/map/create-species-undef.js`
- `test/built-ins/Array/prototype/filter/create-species-undef.js`
- `test/built-ins/Array/prototype/findIndex/predicate-call-parameters.js`

## Root-cause hypothesis

The inlined/lowered iteration loop for these methods drops a value off the
operand stack on one control-flow edge:
- `local.set (need 1, got 0)` — the accumulator (reduce) or result temp is
  consumed without being produced on the early-exit / empty-array edge.
- `if (need 1, got 0)` — a predicate branch leaves the stack empty when the
  callback path is taken vs. the species/length-observing path.
- `array.set (need 3, got 2)` — the map/filter store emits index+array but
  not the value when the callback result coercion is skipped.

Likely site: the Array iteration intrinsic lowering in `src/codegen/`
(builtin Array method codegen, the reduce/map/filter loop emitters). Audit
the empty-array / species-undefined / abrupt-callback control-flow edges to
ensure every path either pushes the loop-body result or branches before the
consuming op.

## Acceptance criteria

- The five example tests above compile to a valid Wasm module (no
  `invalid Wasm binary` / stack-underflow).
- >=120 of the 156 tests in this cluster move off `compile_error`.

## Resolution (2026-05-27)

The original 156-test stack-underflow cluster (`local.set`/`if`/`array.set
need N got N-1`) was **already resolved** by intervening merges between
2026-05-24 and 2026-05-27 — the committed test262 baseline showed only **10**
remaining `compile_error` entries in the Array iteration cluster, and none
were the cited stack-underflow examples (those now `fail` on species
semantics, having compiled cleanly).

The 10 residual `compile_error`s were two distinct, narrower codegen bugs,
both fixed here:

1. **map bridge result not boxed** (8 tests: `map/create-ctor-*`,
   `map/create-species-*`, `map/create-revoked-proxy`, `map/15.4.4.19-4-7`).
   `compileArrayMap`'s host-bridge branch (`src/codegen/array-methods.ts`)
   only coerced the f64 bridge result to i32 — never f64→externref. When the
   source array is untyped (`new Array(n)`, element type externref) the
   `array.set` expected externref but found f64 →
   `array.set[2] expected type externref, found call of type f64`. Fix:
   replace the i32-only coercion with the general
   `coercionInstrs(ctx, {kind:"f64"}, mapResultElemType, fctx)`, which boxes
   via `__box_number` for the externref target.

2. **reduceRight 2-arg bridge never registered** (2 tests:
   `reduceRight/15.4.4.22-4-2`, `15.4.4.22-4-7`). The `__call_2_f64` import
   pre-scan (`collectFunctionalArrayImports` in `src/codegen/index.ts` and the
   parallel scan in `src/codegen/declarations.ts`) only set `need2` for
   `"reduce"`, and `reduceRight` was absent from `FUNCTIONAL_ARRAY_METHODS`.
   A non-closure `reduceRight` callback hit the bridge path with no registered
   import → "Missing __call_2_f64 import for reduceRight". Fix: add
   `reduceRight` to the set and treat it like `reduce` (needs the 2-arg
   bridge) in both pre-scans.

## Test Results

All 10 baseline `compile_error`s now compile to valid Wasm (verified per-file
via `runTest262File`): 2 `pass`, 8 `fail` (species/abrupt-ctor runtime
semantics, out of scope). Guarded by `tests/issue-1601.test.ts` — 10 cases
that fail on clean main and pass with the fix. No regressions in the
previously-passing/`fail` cluster members (isolated per-process runs).
