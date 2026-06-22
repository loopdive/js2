---
id: 2594
title: "Standalone TypedArray/ArrayBuffer host-import leaks — isView, BigInt64Array ctor, DataView BigInt accessors"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-typedarray-2595-2597
sprint: 65
created: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray/ArrayBuffer host-import leaks

## Problem

Several TypedArray/ArrayBuffer surface ops **compile** in `--target standalone`
but leak `env.*` host imports, so the resulting module fails to instantiate
standalone (`WebAssembly.instantiate(): Import #0 "env": module is not an object
or function`). Verified on upstream/main:

| op | leaked env import |
|---|---|
| `ArrayBuffer.isView(x)` | `env.__arraybuffer_isView` |
| `new BigInt64Array(n)` | `env.BigInt64Array_new` |
| `new BigUint64Array(n)` | `env.BigUint64Array_new` |

(`DataView.getBigInt64`/`setBigInt64` compile clean on the windowed path but
should be checked for an env leak on the bare-vec path — see edge cases.)

These break the **entire module** standalone, not just the one expression — any
test that calls `ArrayBuffer.isView` or constructs a BigInt typed array fails to
run at all. Part of the `built-ins/ArrayBuffer` (78) and BigInt typed-array
buckets.

## Root cause

**`ArrayBuffer.isView`** — `src/codegen/expressions/calls.ts` line ~6360 always
emits `ensureLateImport(ctx, "__arraybuffer_isView", …)` with no standalone
fallback. But standalone has a native isView check already (used by `delete`,
`Array.isArray`, etc.): an `any.convert_extern` + `ref.test` over the registered
typed-array/dataview vec types (the same `vecTypeIdxs` ref.test fan-out used in
`emitIsArrayTerminal`, property-access.ts ~470). For most test262 calls the
argument's TS type is statically a TypedArray/DataView (→ const `true`) or a
non-view (→ const `false`).

**`BigInt64Array_new` / `BigUint64Array_new`** — the BigInt64/Uint64 ctor path
(new-super.ts) routes to a host import instead of building a native i64-element
vec. These views need an `i64`-element packed vec (`getOrRegisterVecType("i64", …)`),
mirroring the integer-view ctor path.

## Implementation Plan

### A. `ArrayBuffer.isView` native standalone (`calls.ts` ~6360)
Gate on `noJsHost(ctx)`:
1. **Static-decide when possible**: inspect the argument's TS type via
   `ctx.checker.getTypeAtLocation(arg)`. If it resolves to a TypedArray /
   DataView name (`TYPED_ARRAY_NAMES.has(sym.name)` or `DataView`), drop the
   compiled arg and emit `i32.const 1`. If it resolves to a non-object /
   non-view primitive, emit `i32.const 0`. (ArrayBuffer itself is NOT a view →
   `false`.)
2. **Runtime fallback** (arg type is `any`/union): reuse the
   `emitIsArrayTerminal`-style `ref.test` fan-out over the registered TA/DataView
   vec type indices (`any.convert_extern` then `ref.test $vec_*` OR-chained,
   plus a `ref.test $__dv_window`). Return `i32`. Do NOT call
   `ensureLateImport(__arraybuffer_isView)` in the noJsHost branch.

### B. `BigInt64Array` / `BigUint64Array` native ctor (`new-super.ts`)
In the typed-array ctor lowering, add the two BigInt views to the native path:
- Element storage `i64` (signed/unsigned distinguished on read like #2593).
- `new BigInt64Array(n)` → `array.new_default` of `n` i64 elements + `struct.new`.
- `new BigInt64Array([1n, 2n])` → element-init loop, each element an i64.
- Element get/set go through `array.get`/`array.set` on the i64 vec; element
  values are bigints (already i64 in the brand-gated bigint representation,
  per `project_bigint_i64_brand_gate`). Read signedness: `BigInt64Array`→signed
  i64 (no extend needed, i64 is the value type), `BigUint64Array`→unsigned
  semantics affect `toString`/compare only.
- Register the i64 vec type late+once (type-index discipline).
- **If** the i64-bigint-brand ValType decision (#1349/#1644, architect-gated)
  is NOT yet resolved enough to safely thread bigint element values, scope this
  slice to **part A only** (isView) and split the BigInt64Array ctor into a
  follow-up that depends on that brand decision. Note which applies in the PR.

### Edge cases
- `ArrayBuffer.isView(undefined)` / `(null)` → `false` (not a trap).
- `ArrayBuffer.isView(new ArrayBuffer(8))` → `false` (buffer is not a view).
- `ArrayBuffer.isView(new DataView(buf))` → `true` (include `$__dv_window` and
  the bare-vec DataView shape in the runtime ref.test set).
- DataView `getBigInt64`/`setBigInt64` — verify on BOTH the bare-vec and
  `$__dv_window` recover paths (`recoverDvBacking`, dataview-native.ts) that no
  env import leaks; if it does on the bare-vec path, route through the native
  i64 little/big-endian byte reassembly already used for `getFloat64`.

### Files
- `src/codegen/expressions/calls.ts` (`ArrayBuffer.isView` arm ~6360)
- `src/codegen/expressions/new-super.ts` (BigInt64Array / BigUint64Array ctor)
- `src/codegen/property-access.ts` (reuse the `vecTypeIdxs` ref.test fan-out
  helper for isView runtime fallback; BigInt view byteLength byte-size = 8)
- `src/codegen/dataview-native.ts` (BigInt accessor leak check, if any)

### Representative failing test262 paths
- `test/built-ins/ArrayBuffer/isView/*`
- `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/*` (BigInt64Array)
- `test/built-ins/TypedArray/prototype/...` BigInt64Array variants
- `test/built-ins/DataView/prototype/getBigInt64/*`, `setBigInt64/*`

### Estimated rows
~30-70 standalone passes — isView is a small direct bucket but the env-leak
**unblocks whole modules** that construct/check views, so the effective row gain
is larger than the direct isView/BigInt test count.

## Notes
Substrate-independent for part A (isView). Part B (BigInt64Array) touches the
bigint i64 brand (`project_bigint_i64_brand_gate`) — split out if the brand
decision blocks it. The `emitIsArrayTerminal` ref.test fan-out
(property-access.ts ~470) is the proven template for the native isView check.

## Resolution (2026-06-22) — Part A only; Part B split out

Per the spec's scoping clause, **Part A (`ArrayBuffer.isView`)** is implemented
here; **Part B (BigInt64Array / BigUint64Array native ctor)** is split to a
follow-up because it touches the unresolved i64-bigint-brand ValType decision
(#1349/#1644, `project_bigint_i64_brand_gate`) — landing it now would couple
this conformance slice to an architect-gated representation choice.

**Part A — `ArrayBuffer.isView` host-free** (`src/codegen/expressions/calls.ts`):
gated on `noJsHost(ctx)`, the arm no longer emits the leaking
`__arraybuffer_isView` env import (which broke the WHOLE module at instantiate).
§25.1.4.1 — isView is true iff the arg has a [[ViewedArrayBuffer]] slot:
- **Static-decide** on the resolvable arg type: TypedArray name / `DataView`
  (and `BigInt64Array`/`BigUint64Array`) → `i32.const 1` (drop side-effecting
  arg); a resolvable non-view (ArrayBuffer, primitive, null/undefined, plain
  array, class/object) → `i32.const 0`.
- **Runtime fallback** for `any`/union args: `any.convert_extern` + `ref.test`
  over the registered `$Vec` carriers OR the `$__dv_window` struct. Documented
  imprecision: standalone shares the `$Vec` carrier between `number[]` and
  TypedArrays, so a plain array read through an `any` arg reads as a view — an
  accepted edge for the rare untyped call; the win is not leaking the host
  import. Host/gc mode is unchanged (still routes the host import).

Validated: `tests/issue-2594.test.ts` (7 tests) — Int32Array/DataView → true,
ArrayBuffer/primitive/null → false, `any` fallback, and a whole-module
instantiate-and-compute proof (the env leak previously broke the entire
module). tsc + prettier + coercion-sites clean; packed-typedarray and
dataview-window suites still green.

**Follow-up (Part B):** BigInt64Array / BigUint64Array native ctor (i64-element
vec) + the DataView `getBigInt64`/`setBigInt64` bare-vec env-leak check —
blocked on the i64-bigint-brand decision; should be a fresh issue once that
lands.
