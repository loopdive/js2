---
id: 6870
title: "boolean[] passed to an `Array<unknown> | string` parameter reads elements as numbers 0/1 — jest diff-sequences 'length 1/2'"
status: ready
sprint: Backlog
created: 2026-10-06
updated: 2026-10-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: npm-library-support
requested_by: ttraenkler/wave11-jest
related: [4616, 6867, 1788]
---

# #6870 — boolean vec brand lost at a union-typed array boundary

## Problem

jest `diff-sequences/src/__tests__/index.test.ts` "length 1" / "length 2"
(`expectCommonItems([false], …)`) fail with `toEqual mismatch` in Wasm, pass in
node. Measured 2026-10-06 on `42d289a96f`. Reduction (JS-host lane):

```ts
const first = (a: Array<unknown> | string): unknown => a[0];
const firstU = (a: Array<unknown>): unknown => a[0];
const a = [false, true];
first(a);   // number 0   (node: false)
firstU(a);  // boolean false — the vec→vec conversion keeps the brand
```

The union parameter is `externref`; the `boolean[]` vec (an `i32` array) is
passed with a bare `extern.convert_any`, and the host-side element read
(`__vec_get` / `__extern_get`) boxes the `i32` slot as a number — the boolean
brand lives only in the compile-time `ValType`.

A separate diff-sequences test, "is not a number" (`diff('0', 0, …)` under
`@ts-expect-error`), fails because a string reaches a `number`-typed parameter
and is coerced to `0`, so the `aLength` guard never throws. Not part of this
issue's fix; listed for the cluster record.

## Implementation Plan

1. Find the struct→externref boundary for vec carriers
   (`src/codegen/struct-boundary-reify.ts`, `structMustReifyAtExternrefBoundary`,
   and the vec arm of `coerceType`); when the source vec's element ValType is a
   boolean-branded `i32`, materialize a host array of booleans (or tag the
   carrier so `__vec_get` boxes with `__box_boolean`) instead of passing the
   raw struct.
2. Keep identity semantics in mind: a reified copy breaks writes through the
   parameter; prefer a brand tag read by the runtime getter if mutation through
   `Array<unknown>` must stay visible.
3. Regression test: `first([false])` returns `false` (typeof boolean), with the
   `Array<unknown>`-only parameter as control; re-measure jest diff-sequences.
