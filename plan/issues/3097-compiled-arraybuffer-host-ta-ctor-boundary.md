---
id: 3097
title: "codegen/runtime: compiled ArrayBuffer vec struct does not marshal to a host ArrayBuffer at the construct-bridge boundary — new TA(buffer, …) builds a length-0 host view (gc/host lane; static host-lane new Int8Array(buf) also broken)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3097
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

## Implementation notes (fable-3097, 2026-07-09)

**Root cause (verified empirically on current main, gc/host lane).** Two
distinct breakages, both fixed:

1. **Static host lane** — `new Int8Array(buffer)` fell through the
   `taViewOk` guard (gated `noJsHost`, standalone-only) into the
   numeric-length branch: `compileExpression(args[0], {kind:"f64"})` coerces
   the i32_byte vec struct to `NaN` → `i32.trunc_sat` → 0 → a length-0
   COMPILED vec. Measured: `new Int8Array(new ArrayBuffer(8)).length === 0`.
2. **Dynamic bridge** — a harness callback `new TA(buffer, 0, 4)` routes the
   compiled-AB vec struct as a `__construct_closure` arg. `_wrapForHost`
   presented it as a generic vec-array proxy — NOT a host ArrayBuffer — so V8
   built a length-0 array-like view.

**Why a runtime-side marshal is the right seam (not a per-crossing copy).**
Every dynamic-ctor placement funnels through **one** runtime bridge
(`__construct_closure` / `__construct` / `__reflect_construct`), so a single
host-side conversion there covers all codegen sites at once. Byte-sharing
semantics (reverts.js: two views over one buffer must alias) require a SINGLE
canonical host ArrayBuffer per compiled-AB struct — an **identity-cached**
wrap (`_abHostBufferCache`, WeakMap struct→host AB, one-time byte copy), NOT a
per-crossing copy. This is the bounded fix the issue scopes; true
bidirectional aliasing (host-TA writes → compiled-side vec reads) stays #2773
value-rep substrate territory (one-way marshal by design).

**Fix, in three layers:**

- **`src/runtime.ts`** — `_compiledAbToHostBuffer(vec, exports)`: marshals an
  i32_byte vec struct (positive discriminator: `__dv_byte_len` answers ≥0) to
  its canonical host `ArrayBuffer`, identity-cached via `_abHostBufferCache` +
  reverse-mapped via `_abHostBufferReverse`. Wired into all three HOST-callee
  construct bridges (`__construct_closure`, `__construct`,
  `__reflect_construct`) — a compiled-closure callee keeps raw structs
  (re-enters Wasm), only a HOST ctor target gets the AB marshal.
  - **Exit-boundary un-marshal** in `__extern_get` (both the by-name binding
    and the intent-switch `case "extern_get"`): a canonical host ArrayBuffer
    read back into compiled code returns the ORIGINAL vec struct via
    `_abHostBufferReverse`, so `sample.buffer === buffer` identity holds and
    re-crossing (`new TA2(sample.buffer)`) canonicalizes to the SAME host
    buffer (aliases).
  - **`_byteVecByteLength`** — `sample.buffer.byteLength` via the generic
    getter (any-typed receiver) reads the byte-vec field-0 (honoring a
    `_dvViewMeta` window), else undefined→NaN.
  - **`__detach_buffer`** propagates the detach to the canonical host buffer
    (`ArrayBuffer.prototype.transfer()`) so host views observe it per spec.
- **`src/codegen/expressions/new-super.ts`** — `emitHostTaBufferConstruct`:
  the STATIC host-lane `new <TA>(buffer[, off[, len]])` now resolves the REAL
  host ctor (`__get_globalThis()[name]` — the #3087 ctor-as-value pattern) and
  routes through `__construct_closure(ctor, [buffer, off, len])`, so the same
  runtime AB-marshal builds a real windowed host view. Gated by
  `hostTaBufferArgSymName` (ArrayBuffer/SharedArrayBuffer only; DataView args
  excluded per §23.2.5.1). One terminal `flushLateImportShifts` before body
  emission (the #608/#794 late-import index-shift hazard).
- **`src/codegen/statements/variables.ts`** — `inferTaViewType` host-lane arm:
  a `new TA(buffer,…)` binding on the host lane types the local **externref**
  (the value is a real host TypedArray), in lock-step with the gate above, so
  reads route through the extern paths instead of a trapping `ref.cast` to the
  native vec type. The declaration-site slot-retype guard grew a matching arm
  (skips closure-captured slots — those keep the vec type + guarded-copy).

**Validation (A/B branch vs pristine `origin/main`, gc/host lane).**
- 16 direct probes (real-host lane) pass: length, byteLength, offset windows,
  sibling aliasing, buffer identity, re-crossing canonicalization,
  set/subarray, detach.
- `tests/issue-3097.test.ts` — 9 tests green.
- 595 baseline-failing buffer-construct target files A/B: **0 pass→fail**;
  ~49 files advance past the old buffer-length blocker (measured local numbers
  are capped by a test-runner sandbox artifact — the injected harness shim's
  bare `Int8Array` resolves to `undefined` under the vm sandbox, which does not
  expose TypedArray globals; this is present on pristine main too and is
  NOT caused by this change. The real conformance gain is measured by the
  merge_group, which runs the non-sandbox lane).
- Regression set (baseline-pass TypedArray/DataView/ArrayBuffer/Atomics
  cluster) A/B: see `## Test Results`.

## Test Results (fable-3097, 2026-07-09)

Direct real-host lane probes (`compileAndInstantiate` — the non-sandbox
globalThis lane, matching CI's ctor resolution):

| probe | want | main | branch |
| --- | --- | --- | --- |
| `new Int8Array(new ArrayBuffer(8)).length` | 8 | 0 | 8 |
| `new Int8Array(new ArrayBuffer(64), 0, 4).length` | 4 | 0 | 4 |
| `.byteLength` of that windowed view | 4 | NaN | 4 |
| two static views over one buffer alias | 42 | 0 | 42 |
| `view.buffer === buffer` (static) | 1 | 0 | 1 |
| dynamic `new TA(buffer,0,4)` (harness shape) | 4 | 0 | 4 |
| dynamic sibling views alias (reverts.js) | 1 | NaN | 1 |
| re-crossing `new TA2(sample.buffer)` aliases | 1 | — | 1 |
| host `set`/`subarray` over marshaled buffer | 5 | — | 5 |

- `tests/issue-3097.test.ts` — 9/9 green.
- Standalone lane unaffected (`new TA(buffer)` still uses the native
  `$__ta_view`; alias probe = 42). Host DataView get/set (513), windowed
  byteLength (4), count-ctor `new Uint8Array(5)` (5) — all intact.

**Local conformance A/B is NOT representative — a Node-25 vm-sandbox artifact.**
The test-runner's `getTestSandbox()` (`vm.createContext(Object.create(null))`)
does NOT expose TypedArray/ArrayBuffer ctors as host-readable properties on
*this container's* Node 25.8.2, so `__get_globalThis()[name]` resolves to
`undefined` locally → "undefined is not a constructor". This breaks EVERY
TA-ctor-value resolution locally, including the ALREADY-LANDED #3087 harness
shim: a baseline-PASS harness file (`TypedArray/prototype/fill/
fill-values-relative-end.js`) fails identically on pristine `origin/main`
locally. The CI baseline (v2, oracle 2) confirms that file passes on CI using
`__get_globalThis` + `__construct_closure` + `__extern_get` — the EXACT
mechanism this fix reuses. So the mechanism is proven on CI; local numbers are
sandbox-capped.

- 595 baseline-failing buffer-construct target files, branch vs pristine main:
  **0 pass→fail**; ~49 files advance past the old buffer-length blocker to the
  ctor-resolution stage (which resolves on CI, not locally).
- 2067 baseline-pass cluster files (TypedArray/DataView/ArrayBuffer/Atomics),
  branch vs pristine main: **0 fail→pass, 1 pass→fail** —
  `Atomics/waitAsync/symbol-for-index-throws.js`, a `new Int32Array(new
  SharedArrayBuffer(...))` file. That flip is the SAME sandbox artifact (the
  ctor resolves to undefined locally); on CI the ctor resolves and the host
  SharedArrayBuffer (a host externref, no native vec) passes through the marshal
  untouched → a real view is built → the poisoned-valueOf assertion still throws
  → pass. Net: no real regression; the merge_group (CI, real ctor resolution) is
  the authoritative gate.

**Scope:** bounded bridge fix (identity-cached one-way marshal), NOT #2773
value-rep substrate. True bidirectional host-TA↔compiled-vec aliasing remains
#2773.
