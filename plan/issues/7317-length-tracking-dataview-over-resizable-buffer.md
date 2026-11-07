---
id: 7317
title: "A length-tracking DataView over a resizable ArrayBuffer keeps its construction-time length"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7274]
---

# Length-tracking DataView keeps a fixed length

## Problem

A view constructed without a `byteLength` over a resizable buffer is
length-tracking (§25.3.2.1 step 10–11, `[[ByteLengthAuto]]`). Its
`byteLength` follows the buffer through `resize`, and accesses past the old
length succeed once the buffer has grown.

The native `$__dv_window` built by legacy, and reused by the IR adapter
`__ir_dv_new` (#7274 slice 2), stores a fixed `byteLength` at construction.
After `resize` the view still reports the old length and rejects accesses
past it.

Both routes share the same emitter (`emitDataViewWindow`,
`src/codegen/buffers/data-view-native.ts`), so they agree, and both are wrong.

## Repro

```js
var rab = new ArrayBuffer(4, { maxByteLength: 16 });
var v = new DataView(rab);
rab.resize(8);
assert.sameValue(v.byteLength, 8);
v.setUint8(7, 5);
assert.sameValue(v.getUint8(7), 5);
```

| Lane | Result |
| --- | --- |
| node | pass |
| gc | fail (`byteLength` 4) |
| standalone | fail (`byteLength` 4) |

Measured 2026-11-07 on #7161's head (1af545db) and on a84cddb1. The repro
itself takes the legacy route, because `resize` is outside the IR table. A
view the IR constructs has the same fixed window.

## Acceptance

- A view built over a resizable buffer without a `byteLength` tracks the
  buffer:
  - `byteLength` reads the current buffer length minus the offset;
  - the bounds of `get*` / `set*` use that length;
  - a shrink below the offset makes the view out of bounds, so `byteLength`
    throws a TypeError per §25.3.4.1.
- A view with an explicit `byteLength` keeps its fixed window.
- The window layout change (a "length-auto" flag, or a sentinel) goes into
  the one emitter both routes use.
