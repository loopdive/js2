---
id: 1670
slug: atomics-illegal-cast-regression
title: "Atomics negative tests trap with `illegal cast` (regressed by #1654 / PR #599)"
sprint: 55
status: done
feasibility: hard
depends_on: []
regressed_by: 1654
---

# #1670 — Atomics `illegal cast` regression from #1654

## Problem

PR #599 (`32071e49c`, `fix(#1654): ArrayBuffer/DataView/TypedArray valid under
--target wasi`) flipped **28** `built-ins/Atomics/{wait,waitAsync,notify}/*`
test262 tests from `pass` to `illegal cast`. The Atomics illegal-cast bucket
jumps from 1 → 52 at exactly this commit and persists.

Most of the affected tests are **negative** (`assert.throws`): they construct
`new Int32Array(new SharedArrayBuffer(...))` and then expect a
`RangeError`/`TypeError` from a bad index / non-integer / detached or
non-shared buffer. They previously passed by throwing correctly.

## Root cause

#1654 added a native "byte-buffer view" path for `new TypedArray(buffer)` in
`src/codegen/expressions/new-super.ts` (`emitTypedArrayFromByteBuffer`, plus
two call sites at the single-arg TypedArray and Uint8-family constructors). The
path emits an **unconditional** `ref.cast` (`any.convert_extern` + `ref.cast`)
to the native `i32_byte` vec struct that backs a standalone/WASI ArrayBuffer.

In **JS-host mode** that assumption is false:
- `new ArrayBuffer(n)` is lowered to the `i32_byte` vec **only** in the
  dedicated `className === "ArrayBuffer"` branch — and even then host code may
  carry it as an externref.
- `new SharedArrayBuffer(n)` has **no native struct lowering at all** — it
  falls through to the generic extern/host path.

So `new Int32Array(new SharedArrayBuffer(...))` reached `ref.cast i32_byte` on a
value that is not an `i32_byte` vec → the cast **traps with `illegal cast` at
construction time**, before any spec-required `ValidateAtomicAccess` /
`ToIndex` throw could run. The negative tests then see a wasm trap instead of
the JS `RangeError`/`TypeError` they assert.

Reproduced on main HEAD (with #608 reverted) via `buildImports` +
`WebAssembly.instantiate`:

```
new Int32Array(new SharedArrayBuffer(16)) → RUNTIME: illegal cast
```

## Fix

Gate **both** `emitTypedArrayFromByteBuffer` call sites on `noJsHost(ctx)`
(`ctx.wasi || ctx.standalone`). The byte-buffer view is only needed — and only
sound — in standalone/WASI mode, where the buffer genuinely is the `i32_byte`
vec. #1654's six tests are all `target: "wasi"`, so they keep the native path.
In JS-host mode the buffer arg is handled by the runtime as before #1654, so
construction no longer traps and the Atomics spec throws surface correctly.

This is a TARGETED fix — #1654's WASI/standalone DataView/TypedArray validity
work is untouched.

### Files

- `src/codegen/expressions/new-super.ts`
  - import `noJsHost` from `./helpers.js`
  - guard the single-arg TypedArray buffer-view branch (`~L1884`)
  - guard the Uint8-family buffer-view branch (`~L2420`)
- `tests/issue-1670-atomics-typedarray-cast.test.ts` — regression test
  (positive `new Int32Array(new SharedArrayBuffer(n))` constructs + indexes
  without `illegal cast`; negative shape proves a guarded bad-index throw is
  reached rather than pre-empted by a trap).

## Test Results

- `tests/issue-1670-atomics-typedarray-cast.test.ts` — 2/2 pass
- `tests/issue-1654-wasi-dataview-arraybuffer.test.ts` — 5/5 pass (no regression)
- `tsc --noEmit` clean; `biome lint` clean on changed files
- Pre-existing `tests/typed-array-basic.test.ts` /
  `tests/arraybuffer-dataview.test.ts` failures (missing `string_constants`
  import in the test harness) reproduce identically without this change — not
  caused here.

Expected test262 effect: net ~+28 (Atomics illegal-cast bucket 52 → ~1).
