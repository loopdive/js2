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

## 2026-06-21 sd-4 — root cause revised, attempt REVERTED (net-negative), retry guidance

**Framing was stale.** This is NOT a missing-`__sset_` host write-back build:
the `__sset_<field>` setters already exist and `_safeSet` already wires them.
The real bug is a **codegen dispatch gap**: a call `obj.method(args)` where
`method` is a **host function value** stored in `obj`
(`var o = {}; o.pop = Array.prototype.pop; o.pop()`) falls past every
static/struct-method handler and hits the **graceful-null fallback** in
`compileCallExpression`, which compiles the callee property-access, **drops**
the method, and pushes `ref.null.extern` — so the call is never made
(`o.pop()` yields `null` not `undefined`, no mutation).

**Attempt (PR #1844) reverted + closed.** The dual-path fix — route such calls
to `__extern_method_call(receiver, method, args)` with the live-mirror proxy
before the graceful-null fallback — fixed the 19-file generic-method-on-
plain-object cluster locally (0 → 11/19) but was **net −200 / 323 regressions
on the full merge_group test262 gate**. The graceful-null `undefined`-return is
**load-bearing for far more call shapes** than the targeted cluster; the
syntactic gate (any unresolved `obj.method()`) was far too broad.

**Retry requirements (MANDATORY before any re-attempt):**
1. **Gate MUCH tighter** — route to `__extern_method_call` ONLY when the callee
   field is *provably a host function value* (e.g. the receiver is statically an
   object/struct whose `<method>` is a known externref field assigned a host
   function), NOT every unresolved property-access call. The broad
   "fell-through-to-fallback" trigger caused the −200.
2. **Validate via the FULL gate** — `JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh`
   (full local test262, ~68 min) OR accepted-into-the-merge_group-as-validator.
   A scoped sweep / N-file sample CANNOT validate a dispatch/call-path change
   (standing team rule, 2026-06-21). Confirm net ≥ 0, ratio < 10%, no bucket
   > 50 before enqueue.

Residual carved to **#2573** (reading a missing property on a plain `{}` object
returns `null` not `undefined` — the `obj.length === undefined` assertions in
the longer cluster variants), an orthogonal property-read bug.
