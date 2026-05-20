---
id: 1515
sprint: 52
title: "spec gap: DataView — ToIndex(byteOffset), detached-buffer TypeError, BigInt setter coercion"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: dataview
goal: spec-completeness
related: [1461]
---
# #1515 — DataView spec fidelity (ToIndex, detached, BigInt)

## Problem

`built-ins/DataView/prototype/{getInt32,getBigUint64,setUint8,setBigInt64,…}/`
contributes **~150 failing test262 cases**. Excluding the
~50 `No dependency provided for extern class "SharedArrayBuffer"`
entries (which are skip-filtered at the runner), there are
**~100 actionable** failures across three sub-clusters.

### Sub-cluster A — `toindex-byteoffset.js` (~25)

Every getter/setter ships with a `toindex-byteoffset.js` test that
calls

```js
dv.getInt32({ valueOf() { throw new MyError(); } });
```

Spec §25.3.1.* step 2 is `byteOffset = ToIndex(byteOffset)`, which
calls `ToIntegerOrInfinity(ToNumber(byteOffset))`. The user-side
`valueOf` must run *before* the receiver-class check. We emit:

```
Cannot convert object to primitive value
```

— close, but wrong: the spec wants the original abrupt completion
propagated, not a wrapped TypeError with a different message.

### Sub-cluster B — `detached-buffer.js` (~20)

```js
const dv = new DataView(new ArrayBuffer(8));
$DETACHBUFFER(dv.buffer);
assert.throws(TypeError, () => dv.getInt32(0));
```

Per §25.3.1.4 step 3 (and similar in each getter/setter), if the
underlying buffer is detached the method must throw `TypeError`.
Currently we silently return stale data or `undefined`. The
runtime also fails to honour `dv.byteLength` / `dv.byteOffset`
detached semantics.

### Sub-cluster C — `setBigInt64` / `setBigUint64` value coercion (~10)

```js
dv.setBigInt64(0, -1);     // expected: ToBigInt(-1) → -1n
dv.setBigUint64(0, 2n);    // expected: encodes 2n
```

We throw `Cannot convert -1870724872 to a BigInt`. The f64 → BigInt
path in `__to_bigint` is missing the safe-integer branch — it routes
all f64 inputs through a textual parse instead of the
`Number → IntegerIndex → BigInt` shortcut for safe integers.

### Sub-cluster D — getter return-undefined / setter return-undefined (~15)

`set-values-return-undefined.js` requires that every setter returns
`undefined`. We return the stored value (the runtime helper passes
through the f64 input). The harness `byteConversionValues is not
defined` is a separate test262 host-shim issue (~10 entries) — these
go away once the runner's harness include list is extended (not
codegen).

## Failure count

**~100 fails**. Realistic target: **≥ 70 flips**.

## Root cause + files to touch

- `src/codegen/typed-arrays.ts` or `src/codegen/dataview.ts` (the
  DataView family lives near the TypedArray code) — add a
  `ToIndex(byteOffset)` prologue that runs user-side `valueOf`
  and threads abrupt completions through.
- `src/runtime.ts` — `__dataview_getInt32` etc. should check the
  buffer's detached flag (field on the ArrayBuffer struct introduced
  for `transfer()`) and throw TypeError.
- `src/runtime.ts` — `__to_bigint(f64)`: add safe-integer fast path
  that bypasses the textual route for `[-2^53, 2^53]`.
- `src/codegen/typed-arrays.ts` — every DataView setter should drop
  its return value (emit `drop` + `i32.const 0` reinterpreted as
  ref.null externref → maps to `undefined`).

## Acceptance criteria

1. ≥ 70 of 100 actionable in `built-ins/DataView/prototype/*` flip to
   `pass`.
2. `detached-buffer.js` across all DataView getters/setters passes.
3. `dv.setBigInt64(0, -1)` does not throw.
4. No regression in `built-ins/TypedArray/`.

## Reference tests

- `built-ins/DataView/prototype/getInt32/toindex-byteoffset.js`
- `built-ins/DataView/prototype/byteLength/detached-buffer.js`
- `built-ins/DataView/prototype/setBigInt64/set-values-little-endian-order.js`
- `built-ins/DataView/prototype/getBigUint64/toindex-byteoffset-errors.js`
