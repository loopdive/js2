---
id: 3999
title: "wasm emission: preserve local and call operand types in styled-components"
status: done
created: 2026-07-30
updated: 2026-08-18
completed: 2026-08-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: n/a
goal: dogfood
sprint: 78
horizon: m
related: [3995]
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForStatement
---
# Preserve local and call operand types in styled-components

## Problem

styled-components 6.4.4's published `dist/styled-components.esm.js` compiled,
but the emitted Wasm did not validate. The first failure was:

```text
WebAssembly.Module(): Compiling function #222:"nt" failed:
local.tee[0] expected type (ref null 227), found local.get of type i32
```

Fixing that exposed two later validation failures in the same unchanged package:
an out-of-order omitted-argument vector in `Rt -> Ye`, followed by an invalid
`extern.convert_any` in `__closure_54`.

Reproduce with:

```bash
node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs \
  --package styled-components
```

## Root causes and fixes

### 1. A loop shadow retained the outer capture box

`nt` contains an outer destructured binding named `e` that is captured by a
closure, then a lexical `for (let e = 0; ...)` that shadows it. The loop lowering
saved and replaced `localMap[e]`, but left `boxedCaptures[e]` pointing at the
outer ref cell. Reads of the inner i32 loop counter therefore emitted ref-cell
operations and fed an i32 to a ref-typed `local.tee`.

Lexical loop-head setup now hides the complete outer storage descriptor,
including `boxedCaptures`, and restores it on loop exit. The per-iteration box
path preserves that original saved entry instead of overwriting it.

### 2. Missing parameters were emitted in the wrong order

`Rt` calls `Ye` with one argument. `Ye` has four ordinary parameters followed
by a defaulted array parameter. The caller used two passes: it emitted optional
defaults first, then padded ordinary gaps by count. The array vec intended for
parameter five consequently landed in parameter two's `externref` slot.

Direct named calls now emit every missing source parameter in formal order,
mapping each source position to its expanded Wasm parameter position before
choosing the optional sentinel or ordinary default.

### 3. Object-prototype fallback assumed every nominal class value was a GC ref

`Ut` stores its `instance` dynamically. Although TypeScript still describes the
loaded value as a class instance, the dynamic read produces `externref`.
`compileObjectPrototypeFallback` unconditionally appended
`extern.convert_any` before `toString`, which is invalid on a value that is
already `externref`.

The fallback now converts the actual compiled representation. The same rule is
used for `toString`, `toLocaleString`, `valueOf`, `hasOwnProperty`,
`propertyIsEnumerable`, and `isPrototypeOf`.

## Verification

Measured on 2026-08-11 against the pinned `styled-components@6.4.4` tarball:

- compile succeeds in about 3.36 seconds;
- the emitted binary is 272,297 bytes;
- `WebAssembly.Module` accepts it;
- the catalog still has no runtime differential workload, so runtime
  correctness remains unverified and is not implied by this issue's closure.

Permanent reductions in `tests/issue-3999-parameter-padding.test.ts` cover the
shadowed capture, ordered missing parameters, and dynamically loaded class
receiver. `tests/issue-3978-dynamic-logical-property.test.ts` covers the sibling
dynamic-property logical-assignment failure found while clearing the npm lane.

## Acceptance criteria

- [x] The original `nt` ref/i32 mismatch has a reduced regression.
- [x] Every subsequently exposed validation failure has a stated root cause.
- [x] The unchanged pinned package emits a valid Wasm module.
- [x] No runtime-correctness or performance claim is inferred from validation.

## Provenance

Migrated on 2026-08-01 from a GitHub issue that was created by an agent in
error. This project tracks work as markdown under `plan/issues/`; the GitHub
issue was closed and redirected here.
