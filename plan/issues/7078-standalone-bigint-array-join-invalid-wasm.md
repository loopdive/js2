---
id: 7078
title: "standalone: `join` of a BigInt array emits `ref.as_non_null` on an i64 element — the module fails validation (hono `utils/ipaddr`)"
status: done
sprint: current
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone-gap
language_feature: bigint, arrays
related: [7013]
---

# BigInt array `join` is invalid Wasm standalone

hono `src/utils/ipaddr.test.ts` (16 tests) never compiled: `convertIPv4BinaryToString`
pushes `ipV4 >> BigInt(8 * (3 - i)) & 0xffn` into `[]` and joins it.

```
Compiling function "__closure_N" failed: ref.as_non_null[0] expected reference type, found array.get of type i64
```

## Implementation Plan

`compileArrayJoinNative` (`array-methods.ts`) has element arms for boolean,
number, externref/GC-ref and native strings; an `i64` (BigInt) element fell to
the string arm. Add an `i64` arm that calls the exact native formatter
`bigint_toString` (`emitNativeBigIntFormat`, append-only defined funcs) and
casts its native-string result to `$AnyString`.

## Resolution

Implemented. `utils/ipaddr` now compiles and runs: 0/16 → 7/16. The remaining
9 need values above 2^64 (IPv6 128-bit arithmetic on the i64 BigInt carrier,
`ipV6 >> 112n` wraps) — recorded as a residual, not attempted here.

Regression: `tests/issue-7059-hono-standalone-residuals.test.ts` (the `#7078` block).
