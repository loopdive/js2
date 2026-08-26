---
id: 4757
title: "TypeScript parsePseudoBigInt: octal and large literals return 0x11ffff instead of 0xfffff"
status: in-progress
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen, dogfood
language_feature: strings, numeric-conversion, bitwise
goal: npm-library-support
sprint: current
related: [3994, 3995, 4756]
files:
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/operator-assignment.ts
  - tests/dogfood/typescript-upstream-suite.mjs
  - tests/issue-4757.test.ts
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/operator-assignment.ts
---

# TypeScript `parsePseudoBigInt` octal and large-literal mismatch

## Problem

The unchanged original TypeScript 5.9.3
`src/testRunner/unittests/parsePseudoBigInt.ts` file passes **5/5** in Node but
only **3/5** after compiling the exact release implementation and its
`CharacterCodes` carrier to Wasm. The full selected TypeScript slice is
therefore **9/11 Wasm** versus **11/11 Node**.

The two failures are:

- `can parse octal literals`;
- `can parse large literals`.

The first retained assertion message is exact:

```text
equal mismatch; string:1179647 != string:1048575
```

Those values are `0x11ffff` and `0x0fffff`, a deterministic extra `0x20000`.
The binary and hex rows in the same original file pass. This is runtime numeric
or character-to-digit semantics, not the separate 600-second full TypeScript
package-entry timeout owned by
[package graph traversal](./3994-bound-recursive-package-graph-traversal-for-typescript.md).

## Reproduction

```sh
node --import tsx tests/dogfood/typescript-upstream-suite.mjs --json
```

Use the immutable upstream pin
`microsoft/TypeScript@c63de15a992d37f0d6cec03ac7631872838602cb`.
The adapter must continue extracting the exact release function; do not replace
it with a harness implementation or expected-value table.

## Implementation plan

1. Capture the exact input and output of all five upstream callbacks and add a
   positive control that distinguishes `0xfffff` from `0x11ffff`.
2. Reduce the release implementation to its radix prefix, character-code to
   digit conversion, accumulator update, and decimal-string result. Preserve
   runtime input so constant folding cannot hide the defect.
3. Compare the reduction in Node and compiled Wasm at each intermediate value.
   Determine whether the first divergence is string indexing/charCode,
   octal-radix selection, bitwise coercion, integer-to-decimal conversion, or
   a value-carrier merge. Error text alone is not attribution.
4. Fix the narrow generic compiler/runtime site. Do not special-case
   TypeScript, `parsePseudoBigInt`, the failing literals, or the expected
   string.
5. Commit the reduction in `tests/issue-4757.test.ts`, including passing binary,
   octal, hex, large, and negative/sign controls where the upstream function
   supports them.
6. Rerun the unchanged three-file TypeScript selected suite and at least one
   independent numeric/string-conversion control. Keep the package-entry
   timeout result separate.

## Acceptance criteria

- [x] The exact original `parsePseudoBigInt.ts` file reaches **5/5 Wasm** and
      remains **5/5 Node**.
- [x] The full selected TypeScript lane reaches **11/11 Wasm** and **11/11
      Node**, with the same three modules compiling and validating.
- [x] The fix is generic and covered by a runtime-input regression; no cached or
      precomputed answer and no upstream callback/expectation rewrite is used.
- [x] The 1,750 unavailable TypeScript registrations and the full package-entry
      timeout remain reported separately rather than being inferred fixed.

## Resolution (2026-08-26)

The first divergence is the host/gc representation of numeric TypedArray
elements, not string indexing, radix selection, or decimal conversion. Host/gc
intentionally stores numeric views in f64 vec elements. The existing compound
element write emitted `segments[segment] |= shiftedDigit` directly to that f64
array, so it did not apply the Uint16 width conversion. For the octal boundary
digit, a value such as `7 << 15` retained bits above bit 15 instead of wrapping
to the low 16 bits; the extra bits produced the observed `0x11ffff` result.
Standalone/WASI packed arrays were already width-limited by their i16
`array.set`.

The generic fix adds one host/gc f64-backed integer-view coercion helper:
ToInt32 first supplies JavaScript NaN/infinity/truncation/modulo semantics,
then each Int8/Uint8/Int16/Uint16/Int32/Uint32 view applies its width and
signedness (with the existing Uint8Clamp path preserved). Both simple and
compound element stores use it; no TypeScript source, callback, expectation,
literal, or cached result was changed.

Post-fix exact harness output:

| measure | Node | Wasm |
| --- | ---: | ---: |
| `parsePseudoBigInt.ts` callbacks | 5/5 | 5/5 |
| full selected callbacks | 11/11 | 11/11 |
| selected modules compile/validate | n/a | 3/3 |

The same run still reports **1,750 unavailable registrations** and **253
deferred files** from the extraction boundary. The separate full
TypeScript package-entry **600-second timeout** remains an infrastructure /
scope issue and is not counted as a parser failure.

The focused runtime-input regression
`tests/issue-4757.test.ts` passes **2/2**. Existing typed-array semantic
controls pass **23/23** across
`tests/issue-1787-packed-typedarray-semantics.test.ts`,
`tests/issue-1829.test.ts`, and `tests/issue-2903-r4b.test.ts`. Both
repository typechecks pass.

## Handoff

Implementation is on branch `codex/4757-typescript-pseudobigint`, stacked on
the ready planning PR #5001 only because the issue file originated there.
Before merge, rebase/retarget this branch onto `origin/main` after #5001 lands.
No open PR currently overlaps the generic f64-backed integer TypedArray store
site; the implementation is ready for a non-draft PR.
