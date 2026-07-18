---
id: 3405
title: "js-host: extend the Atomics host-bridge to i64-element native vecs (unblock native js-host BigInt64Array/BigUint64Array)"
status: ready
created: 2026-07-18
updated: 2026-07-18
priority: low
horizon: m
feasibility: hard
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen, atomics, typed-arrays
language_feature: bigint, typed-arrays, atomics
goal: dual-mode
related: [838, 2593]
origin: "2026-07-18 — split out of #838 (BigInt64Array) by fable-dev-5 while fixing the js-host Atomics regression via the standalone-only gate"
---

# #3405 — js-host Atomics bridge for i64-element native vecs

## Context (why this exists)

#838 added native i64-element vec storage for `BigInt64Array`/`BigUint64Array`.
Its first cut routed them to the native vec in **all** lanes, which regressed 5
js-host `Atomics/*/bigint/*` test262 rows (the native i64 vec is not a valid
receiver for the host `Atomics.wait/notify/waitAsync` bridge — index-validation
over an i64 vec does not throw the spec RangeError first). fable-dev-5 fixed the
regression on the #838 PR by **gating the native BigInt storage to
standalone/wasi only** (js-host keeps the host-global `BigInt64Array`, matching
main — dual-mode: host lane rides host paths). That is strictly ≥ main and
unparked the queue, but it means **js-host BigInt64Array does NOT use the native
i64-vec** — it stays on the host global.

This issue is the follow-up to make the native i64-vec work in js-host too, so
`--target` js-host gets the same native BigInt typed-array performance as
standalone.

## Root cause (from #838 diagnosis)

Numeric TypedArrays already ride native (f64/packed) vecs in js-host AND pass
their Atomics tests — because the Atomics host-bridge handles those element
kinds. The bridge does NOT handle an **i64-element** native vec receiver:
`Atomics.wait/notify/waitAsync` over a native i64 vec skips the
`ValidateIntegerTypedArray` / ToIndex range-check that throws
RangeError/TypeError for bad indices, so the poisoned-arg tests reach code that
should be unreachable.

## The 5 tests to keep green when the native js-host path is re-enabled

(They pass today in js-host via the host global; they must also pass once the
native i64-vec path is turned back on for js-host.)

- `test/built-ins/Atomics/wait/bigint/negative-index-throws.js`
- `test/built-ins/Atomics/wait/bigint/out-of-range-index-throws.js`
- `test/built-ins/Atomics/waitAsync/bigint/negative-index-throws.js`
- `test/built-ins/Atomics/waitAsync/bigint/out-of-range-index-throws.js`
- `test/built-ins/Atomics/notify/bigint/non-shared-bufferdata-count-evaluation-throws.js`

## Fix surface

- The `#838 gate` sites (search `#838 gate` — `src/codegen/expressions/new-builtin-globals.ts`,
  `src/codegen/expressions/new-super.ts`, `src/codegen/index.ts:resolveWasmType`):
  remove the `(ctx.wasi || ctx.standalone)` restriction ONCE the bridge lands.
- The Atomics host-bridge (grep `Atomics` / `__atomics_` in `src/runtime.ts` +
  the Atomics codegen): teach it to accept an i64-element native vec receiver
  and run the same index-validation / element read-write it does for numeric
  vecs, using i64 element access.

## Acceptance

- Re-enable the js-host native BigInt path (revert the #838 gate), and the 5
  Atomics/bigint tests above still pass in js-host on the native vec.
- No regression on the numeric Atomics tests or the standalone BigInt path.

## Not in scope

The 3 pre-existing BigInt failures that were mis-attributed to #838 in the
merge_group diff (they fail on plain main too, unrelated to native-vec routing):
`TypedArrayConstructors/BigInt64Array/prototype.js` +
`.../BigUint64Array/prototype.js` (`verifyProperty` — undefined/null prototype
descriptor) and `ctors-bigint/typedarray-arg/other-ctor-returns-new-typedarray.js`
(`Duplicate identifier 'isPrimitive'` compile_error). File separately if not
already tracked.
