---
id: 7371
title: "`b === 1n` with `b: number | bigint` folds to `false`"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6642, 7360]
---

# #7371 — strict equality against a BigInt folds a maybe-BigInt union to `false`

## Problem

Found while testing #7360 (RV7307). On `origin/main` (ee3fcdd610), default and `--target standalone` alike:

```ts
function g(k: boolean): number | bigint { return k ? 1n : 2; }
const b = g(true);
b === 1n;        // node true; we answer false
typeof b;        // "bigint" (the value itself is a correct BigInt box)
```

Measured before the fix: `=== 1n`, `!== 1n`, `1n === b`, `===` against a `bigint` local, and `=== 1n` on a
`bigint | undefined` all answered as if the operands could never be equal.

## Cause

`compileBinaryExpression` (`binary-ops.ts`) folds "a BigInt `===` a provably non-BigInt operand" to a constant via
`emitTypeDisjointStrictEq`. "Non-BigInt" is decided by `isBigIntType`, which is false for a union, so
`number | bigint` and `bigint | undefined` counted as provably non-BigInt. #6642 had already carved `any`/`unknown`
out of the fold, routing them to the runtime strict-equality helper (`ensureExternStrictEqHelper`).

## Implementation Plan

- **One predicate, next to `isBigIntType`.** `typeMayBeBigInt(type)` in `checker/type-mapper.ts` is true for
  `any`/`unknown`, a BigInt type, or a union with a BigInt member.
- **The fold asks it.** The #6642 escape in `binary-ops.ts` now uses `typeMayBeBigInt` instead of its inline
  `any`/`unknown` flag test. It is the same arm with a wider guard, not a second path, and `binary-ops.ts` nets
  zero lines.
- **Quality criterion.** No new comparison path; the existing runtime helper decides every maybe-BigInt operand.

## Result (2026-11-19)

- `tests/issue-7371-bigint-union-strict-equality.test.ts`: 9 programs × gc/standalone, answers from node. Before:
  10 of 18 fail; after: 18/18. A number member (`=== 2`, a number `1` against `1n`) and the #6642 `any` case keep
  their answers.
- Byte identity: 100 test262 files × gc/standalone, binaries identical (200/200).
- Gates: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports
  pass.

### Left open

**Loose `==`** against a BigInt (`b == 1n`) with a BigInt value in an `externref` answers `false` even for
`b: any`, so it is not this fold. The BigInt × Number loose-equality arm converts the dynamic side through ToNumber.
It needs its own issue.
