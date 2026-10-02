---
id: 6728
title: "standalone: coercing a `Uint8Array` subview (`u.subarray(b, e)`) to the flat `$__vec_i8_byte` drops its byte offset"
status: ready
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [2843, 5349, 6714]
---

# #6728 — subview → vec coercion loses the byte offset

## What you will see (standalone, `runtimeEvalProvider: false`, main `2e23e49fb1`)

```js
export function test() {
  const u = new Uint8Array([104, 101, 108, 108, 111]);        // "hello"
  return new TextDecoder().decode(u.subarray(1, 3)) === "el" ? 1 : 0; // got 0
}
```

`u.subarray(1, 3)` builds the subview struct `{ length, data, byteOffset }`.
Any consumer that expects the flat `$__vec_i8_byte` (here
`__textdecoder_decode_u8`) goes through a coercion that emits
`struct.new $__vec_i8_byte (length, data)`. It drops field 2, the byte offset,
so the consumer reads `data[0..length)` ("he"), not `data[1..3)` ("el").
`u.subarray(1, 3).length` and `[0]` read directly on the subview are correct.

## Other findings from the #6714 probe (same carrier, separate root causes)

- `const u: any = new Uint8Array(2); u instanceof Uint8Array` → `0`.
- `function mk(): Uint8Array { return new Uint8Array(3) } mk().buffer.byteLength`
  → `NaN`. The same read on a local `new Uint8Array(3)` gives 3.
- `new TextDecoder().decode(u8.buffer)` (an ArrayBuffer argument) decodes to
  something other than the bytes (`=== "AB"` → 0).

## Fix direction

A subview → flat-vec coercion must copy the window
`data[byteOffset .. byteOffset+length)` into a fresh array. The alternative is
to make the consumer take the subview and read with the offset. Locate the
`if (result (ref null $__vec_i8_byte)) … struct.get $subview 0 / 1 … struct.new`
emitter (`coerceType` subview arm).
