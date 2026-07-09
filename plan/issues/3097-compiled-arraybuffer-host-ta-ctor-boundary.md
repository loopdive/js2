---
id: 3097
title: "codegen/runtime: compiled ArrayBuffer vec struct does not marshal to a host ArrayBuffer at the construct-bridge boundary — new TA(buffer, …) builds a length-0 host view (gc/host lane; static host-lane new Int8Array(buf) also broken)"
status: ready
sprint: current
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: typed-arrays, array-buffer, dynamic-construction
goal: host-independence
related: [3087, 3074, 2800, 1654, 3054, 2773]
created: 2026-07-09
origin: "2026-07-09 #3087 verify-first (fable-3087): after the __-name value fix landed, the buffer-arg construction shape is the next verified TypedArray-harness blocker (~144 baseline-failing files textually construct over a buffer; reverts.js-class)."
---

# #3097 — compiled ArrayBuffer → host TypedArray ctor boundary

## Problem (verified with isolated probes on 2026-07-09, gc/host lane)

On the gc/host lane, `new ArrayBuffer(n)` compiles to a NATIVE i8-packed vec
struct (`i32_byte` key, `src/codegen/expressions/new-super.ts` "new
ArrayBuffer" branch), while a dynamic `new TA(...)` on a harness-provided host
constructor externref routes through the `__construct_closure` host bridge and
constructs a REAL host TypedArray. A compiled-AB vec struct passed as a ctor
arg crosses `_wrapForHost` as a generic proxy / vec array-view — NOT a host
ArrayBuffer — so V8 treats it as a non-buffer object (array-like without
usable length semantics) and builds a **length-0 view**:

```ts
// all measured on current main + #3087 fix; want 4 / 8, all return 0
var b = new ArrayBuffer(64);
testWithTypedArrayConstructors(function (TA) {
  var s = new TA(b, 0, 4); // s.length === 0, s.byteLength NaN
});
new Int8Array(new ArrayBuffer(8)).length; // 0  — STATIC path broken too
new Int8Array(new ArrayBuffer(64), 0, 4).length; // 0
```

The STATIC host-lane path is independently broken: the TypedArray-ctor
lowering's buffer-view branch (`taViewOk`, #3054 B1) is gated `noJsHost(ctx)`
(standalone only), so on the host lane `new Int8Array(b)` falls through to the
"numeric length" branch — `compileExpression(args[0], {kind:"f64"})` coerces
the vec struct to NaN → `i32.trunc_sat` → 0 → a length-0 COMPILED vec.

Byte-sharing semantics (reverts.js-class tests: two views over one buffer must
alias) require a SINGLE canonical host ArrayBuffer per compiled-AB struct
(identity-cached wrap, e.g. WeakMap struct→host AB with a one-time byte copy),
not a per-crossing copy. True bidirectional aliasing (host-TA writes visible to
compiled-side vec reads) is #2773 value-rep substrate territory — scope this
issue to the identity-cached one-way marshal first and measure.

## Measured value

~144 of the 1,109 baseline-failing TypedArray-cluster files textually construct
over a buffer (`new TA(buffer…)` / `new ArrayBuffer`); the reverts.js staged
probe pins the failure at `new TA(buffer, 0, 4)` (stage -3). The
resizable-ArrayBuffer subset additionally needs `.resize` (#3054 C, host lane —
7/80 sampled RTEs say "resize is not a function").

## Entry points

- Bridge arg loop: `src/codegen/expressions/new-super.ts` (the
  `__js_array_push` arg materialization used by both `__construct_closure`
  placements) — a compiled-AB struct arg needs a host-AB conversion before
  push, or `_wrapForHost` (`src/runtime.ts`) needs an AB-vec case (requires a
  host-side discriminator export for the `i32_byte` vec, mirroring `__is_vec`).
- Static host-lane view: extend the `taViewOk` branch (`new-super.ts`) to the
  host lane, or route the host lane's buffer-arg construction through the same
  host-AB conversion + a host construct.

## Acceptance

- The staged reverts.js probe passes end-to-end on the gc/host lane (views
  share bytes; `sample.reverse()` semantics observable through both views).
- `new Int8Array(new ArrayBuffer(8)).length === 8` statically on the host lane.
- No regression in either lane (the compiled-AB vec rep is load-bearing for
  DataView/Atomics lowerings — verify those suites explicitly).
