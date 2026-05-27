---
id: 983d
title: "Live-mirror write-back: host mutations to a WasmGC struct's proxy sidecar never reach the struct field (~11 Array.prototype.*.call fails)"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: Array, host-boundary, wasmgc-struct
goal: async-model
sprint: Backlog
related: [983, 1630, 1631, 1090]
test262_fail: 11
---
# #983d — Live-mirror write-back via `__sset_<field>` struct setters

## Problem

When a WasmGC struct is exposed to the JS host (via `_wrapForHost`, the live
mirror + sidecar machinery in `src/runtime.ts`), **host-side writes** to the
proxy land in the sidecar map but **never propagate back into the underlying
WasmGC struct field**. The Wasm side then reads the stale struct field and
never observes the host mutation — a one-way (read-only) mirror.

This surfaces as ~11 residual `Array.prototype.*.call` mutation-observability
failures: a generic-method call like
`Array.prototype.push.call(wasmBackedObj, v)` (or `.reverse`, `.sort`,
`.fill`, `.copyWithin`) mutates the host-visible proxy, but the compiled Wasm
that later reads the same object's indexed/length fields sees the pre-mutation
values, so the assertion comparing the two views fails.

Found during the #983 re-baseline (task #115, 2026-05-27): the literal
"WebAssembly objects are opaque" cluster is fully closed (read path / live
mirror works), but the **write-back** half of the mirror was never built.

## Root cause

`_wrapForHost` installs a Proxy whose `get` trap resolves through Wasm-exported
struct getters (`__sget_<field>`, `src/runtime.ts:1024`) and the sidecar. There
is a corresponding **`__sget_`** export but **no `__sset_<field>`** setter
export — the `set` trap can only write the sidecar, it has no way to call back
into Wasm to store the value in the actual struct slot. So:

- host `obj.x = v`  →  sidecar gets `x=v`  →  struct field `x` unchanged
- Wasm `this.x`     →  reads struct field  →  sees old value

The divergence is invisible for read-only host access (the dominant case, hence
#983 closing green) and only bites when the host mutates a Wasm-backed object
that Wasm subsequently re-reads.

## Fix sketch

1. **Emit `__sset_<field>` struct setters** alongside the existing
   `__sget_<field>` getters for any struct type that can escape to the host
   (mirror the export-generation site that produces `__sget_`).
2. **Wire the proxy `set` trap** in `_wrapForHost` to call the matching
   `__sset_<field>` export (coercing the JS value to the field's Wasm type)
   instead of, or in addition to, writing the sidecar. Keep the sidecar only
   for keys with no backing struct field (genuinely dynamic props).
3. **Type coercion at the boundary**: the setter import must coerce host values
   to the field's declared Wasm type (f64 / i32 / externref / ref) — reuse the
   `coerceType` boundary helpers.
4. Indexed Array storage (`data` vec) needs an element-store export too, not
   just named fields, for the `Array.prototype.*.call` generic-method cases.

## Acceptance criteria

1. `Array.prototype.push.call(o, v)` (and `.reverse`/`.sort`/`.fill`/
   `.copyWithin`) on a Wasm-backed `o` is observable from subsequent Wasm reads
   of `o`.
2. The ~11 residual `Array.prototype.*.call` mutation-observability test262
   entries flip to PASS.
3. No regression in the read-path live-mirror (#983) or in the sidecar
   descriptor work (#1630/#1631).
4. Focused test: host write → Wasm read roundtrip through `_wrapForHost`.

## Notes

- This is the dual-store **write-back** half of the live-mirror model; #983
  closed the read half. Feasibility hard: touches struct-setter codegen +
  proxy trap + boundary coercion, and the indexed-store path for Arrays.
- Overlaps the descriptor/struct-target-writeback design in #1630/#1631 —
  coordinate so both share one struct-setter export mechanism rather than two.
