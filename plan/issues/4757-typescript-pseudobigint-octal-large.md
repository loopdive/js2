---
id: 4757
title: "TypeScript parsePseudoBigInt: octal and large literals return 0x11ffff instead of 0xfffff"
status: ready
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
  - tests/dogfood/typescript-upstream-suite.mjs
  - tests/issue-4757.test.ts
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

- [ ] The exact original `parsePseudoBigInt.ts` file reaches **5/5 Wasm** and
      remains **5/5 Node**.
- [ ] The full selected TypeScript lane reaches **11/11 Wasm** and **11/11
      Node**, with the same three modules compiling and validating.
- [ ] The fix is generic and covered by a runtime-input regression; no cached or
      precomputed answer and no upstream callback/expectation rewrite is used.
- [ ] The 1,750 unavailable TypeScript registrations and the full package-entry
      timeout remain reported separately rather than being inferred fixed.
