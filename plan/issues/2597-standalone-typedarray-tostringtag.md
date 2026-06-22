---
id: 2597
title: "Standalone TypedArray/DataView/ArrayBuffer @@toStringTag — Object.prototype.toString returns [object Object]"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-typedarray-2595-2597
sprint: 65
created: 2026-06-22
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray/DataView/ArrayBuffer @@toStringTag

## Problem

`Object.prototype.toString.call(typedArray)` returns the wrong tag standalone:

```ts
Object.prototype.toString.call(new Int32Array(2))  // standalone → "[object Object]"  (want "[object Int32Array]")
Object.prototype.toString.call(new DataView(buf))  // → "[object Object]"  (want "[object DataView]")
Object.prototype.toString.call(new ArrayBuffer(8)) // → "[object Object]"  (want "[object ArrayBuffer]")
```

Per §23.2.3.38 (%TypedArray%.prototype[@@toStringTag]) the tag is the typed
array's constructor name; §25.1.5.x / §25.3.4.x give `DataView` / `ArrayBuffer`.

## Root cause

`src/codegen/expressions/calls.ts` `resolveObjectToStringTag` (line 324)
statically resolves the §20.1.3.6 builtin tag for Array / Date / RegExp / Error /
Function / primitive wrappers, but has **no arm for TypedArray / DataView /
ArrayBuffer / SharedArrayBuffer**. Those fall through to the final
`deferOrStandalone("Object")` (line 433) → standalone emits the generic
`"Object"` tag.

## Implementation Plan

### Approach — add a builtin-name tag arm

In `resolveObjectToStringTag`, after the `Date`/`RegExp`/`Error`/`Arguments`
arms (~line 412) and before the callable check, add:

```ts
// §23.2.3.38 — %TypedArray% @@toStringTag is the constructor name.
// §25.x — DataView / ArrayBuffer / SharedArrayBuffer.
if (symName && TYPED_ARRAY_NAMES.has(symName)) return symName;        // "Int32Array", ...
if (symName === "DataView") return "DataView";
if (symName === "ArrayBuffer") return "ArrayBuffer";
if (symName === "SharedArrayBuffer") return "SharedArrayBuffer";
```

`symName` is already computed (line 395, `nn.getSymbol()?.name`). The caller
formats `[object <tag>]` from the returned string, so returning the raw
constructor name is exactly right.

This is correct for **both host and standalone** — the host's
`Object.prototype.toString` sees the opaque Wasm vec and ALSO mis-tags these as
`[object Object]` (same opaque-receiver class as Array/Date/RegExp already
handled here), so returning the static tag is the right fix in both modes, not
just standalone. Do **not** wrap in `deferOrStandalone` — return the tag
unconditionally (mirrors the `Array`/`Date`/`RegExp` arms).

### Edge cases
- `Object.prototype.toString.call(new Int32Array(2).subarray(0,1))` — a subview
  result still types as `Int32Array`, so it tags correctly.
- `X.prototype` of a typed array (`Int32Array.prototype`) is filtered earlier
  (the `.prototype` arm at ~381 → `deferOrStandalone("Object")`) — a typed-array
  *prototype* object is `[object Object]` per spec (no [[TypedArrayName]] slot),
  so the existing `.prototype` filter correctly prevents tagging it as the view.
  Verify the typed-array arm sits AFTER the `.prototype` filter (it does — the
  filter is at line 381, the new arm at ~412).
- A `Uint8Array | undefined` union — `getNonNullableType` (line 386) already
  strips the undefined, so `symName` resolves to `Uint8Array`.

### Files
- `src/codegen/expressions/calls.ts` (`resolveObjectToStringTag`, ~line 412;
  `TYPED_ARRAY_NAMES` is in scope in this file).

### Representative failing test262 paths
- `test/built-ins/TypedArray/prototype/Symbol.toStringTag/*`
- `test/built-ins/DataView/prototype/Symbol.toStringTag/*`
- `test/built-ins/ArrayBuffer/prototype/Symbol.toStringTag/*`
- Plus any test using `assert.sameValue(Object.prototype.toString.call(ta), "[object Int32Array]")`.

### Estimated rows
~15-35 standalone passes (direct toStringTag tests; also benefits host mode for
the opaque-receiver TypedArray/DataView/ArrayBuffer case).

## Notes
Smallest, lowest-risk slice — one static arm in an existing classifier, no new
runtime, no representation work. Substrate-independent. Benefits host mode too
(those receivers are opaque to the host `toString` and currently mis-tag).
Independent of all other slices (different file region from #2595/#2596).
