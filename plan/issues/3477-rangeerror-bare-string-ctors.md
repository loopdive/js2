---
id: 3477
title: "Indexed/number-method RangeError gates throw bare strings — fail authentic-harness `e instanceof RangeError`"
status: done
created: 2026-07-20
completed: 2026-07-20
assignee: ttraenkler/senior-dev
priority: high
task_type: bug
area: test262-conformance
goal: test262-conformance
sprint: 73
horizon: m
related: [3422, 3175, 3191, 3429]
---

# #3477 — bare-string RangeError throws at indexed/number-method construction

## Summary

Several RangeError gates emit a **bare string** via the shared `$exc` tag
instead of a real `RangeError` **instance**:

```ts
then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }]
```

Under the authentic oracle-v8 harness, `assert.throws(RangeError, fn)` checks
`e instanceof RangeError` (constructor identity), so a bare string fails →
**host FAIL** today. This is the same `instanceof`-guard failure family that gave
**#3422** a 313-flip win (bare-string strict-delete → `buildThrowJsErrorInstrs`,
for TypeError) and that **#3175** already fixed for the *dot-access*
`Number.prototype.toString/toFixed` twins.

## Affected sites (all converted)

**`src/codegen/expressions/new-indexed.ts`** (7 sites — indexed built-in ctors):

- `new ArrayBuffer(-1)` → "Invalid array buffer length" (×2: plain + resizable)
- resizable `maxByteLength < 0` → "Invalid array buffer max byte length"
- `byteLength > maxByteLength` → "ArrayBuffer byteLength exceeds maxByteLength"
- `new DataView(buf, offset)` OOB → "Start offset is outside the bounds of the buffer"
- `new DataView(buf, off, len)` OOB → "Invalid DataView length"
- `new Array(-1)` / `new Array(2**32)` → "Invalid array length"

**`src/codegen/expressions/call-tail-dispatch.ts`** (2 sites — computed-access
`Number.prototype` methods, the twins of the already-fixed dot-access sites in
`call-receiver-method.ts`):

- `n["toString"](radix)` radix ∉ 2..36 → "toString() radix must be between 2 and 36"
- `n["toFixed"](digits)` digits ∉ 0..100 → "toFixed() digits argument must be between 0 and 100"

## Fix

Route every site through `buildThrowJsErrorInstrs(ctx, "RangeError", msg, { flush: fctx })`
(the #3175/#3191 real-instance builder in `src/codegen/js-errors.ts`). Dual-mode:
in `--target standalone`/`wasi` the builder emits the in-module Wasm-native
`__new_RangeError` constructor, so no unsatisfiable host import — the #2029
sentinel concern the bare-string form worked around is handled internally. The
now-dead `addStringConstantGlobal` / `ensureExnTag` /
`stringConstantExternrefInstrs` imports were removed from both files.

## Verification

- `tsc --noEmit` clean; biome + prettier clean.
- Behavioral (`tests/issue-3477.test.ts`): `new ArrayBuffer(-1)`, `new Array(-1)`,
  `(5)["toString"](40)`, `(5)["toFixed"](200)` each caught as a **RangeError
  instance** (`e instanceof RangeError` → 1), not a bare string (would be 2).
- CI measures the authoritative host flip count.

## Notes

Scope grew from the 3 sites first reported to all 7 in `new-indexed.ts` — they
are the identical mechanical conversion in the same construction file and include
the high-value `new Array(-1)` + DataView-bounds test262 clusters. Strictly a
correctness improvement (bare-string → real instance); it cannot regress a
passing test (any harness comparing the caught value to `RangeError` was already
failing on the bare string).
