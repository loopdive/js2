---
id: 6433
title: "`ArrayBuffer.isView(new DataView(...))` answers false on the JS-host lane"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Measured while closing [#6415](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6415-isview-first-class-value-host-lane)
(probe `.tmp/6415/probe-dv.mts`, two-file untyped fixture through
`compileProject` + `buildCompiledImports`, `target: "gc"`, `platform: "web"`):

```js
// untyped mod.js
export function directIsView(value) {
  return ArrayBuffer.isView(value);   // DIRECT call — the #5370 route
}
export function makeDataView() {
  return new DataView(new ArrayBuffer(8));
}
```

Both spellings answer **`not-view`** for a compiled `DataView`:

| probe | compiled | Node |
| --- | --- | --- |
| `ArrayBuffer.isView(new DataView(new ArrayBuffer(8)))` (direct) | `not-view` | `true` |
| `const f = ArrayBuffer.isView; f(dv)` (value read) | `not-view` | `true` |

This is **pre-existing and independent of #6415** — that issue fixed the
externref → boolean-i32 return bridge, which made the two spellings AGREE; it
did not change what they agree on. #6415's regression test asserts only the
agreement for the `DataView` case and points here for the shared answer.

## Why (hypothesis, not yet measured)

`ArrayBuffer.isView` is answered on the host lane by the `__arraybuffer_isView`
import, which #5370 corrected to re-ask through `_wrapForHost`. `_wrapForHost`
honours the `__register_typed_array` brand — see
`src/codegen/dataview-native.ts` and the `_wrapForHost` typed-array branch —
but a compiled `DataView` is a different carrier from a `$Vec` typed array and
plausibly carries no brand that `_wrapForHost` recognises, so the import sees
an opaque WasmGC struct and answers `false` correctly for what it was handed.

Worth measuring before choosing an arm: (a) whether the compiled `DataView`
carrier reaches `_wrapForHost` at all, and (b) whether the brand registry has a
`DataView` row or only typed-array rows.

## Acceptance criteria

1. `ArrayBuffer.isView(dv)` answers `true` on the JS-host lane for a
   compiled `DataView` and for a host-built `DataView` crossing in.
2. Anti-vacuity: a plain array literal and a plain object still answer `false`;
   a `Uint8Array` carrier still answers `true` (the #5370 cases stay green).
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. Standalone lane unchanged (this is a host-lane arm), or fixed in the same
   shape if the brand is shared.

## Dispatch

Model: **opus**. Small, located, but the brand registry is shared with the
typed-array path #5370/#5675 touched, so the anti-vacuity cases are the
load-bearing part.

## Implementation Plan

**Measured cause (upstream/main 54c36a9fe3, `.tmp/6433/probe.mts`, gc/web, untyped two-file fixture):** `dvDirect`/`dvValue` → `not-view`; host-built `DataView` crossing in → `view`; `Uint8Array` → `view`; array/object → `not-view`; `makeDataView()` crosses out as `[object Array]`. The brand registry is not the culprit: on the JS-host lane `new DataView(buf, off, len)` **returns the i32_byte buffer struct itself** (`src/codegen/expressions/new-indexed.ts` ~L596–700 — the `$__dv_window` wrap is gated on `windowed = nativeDataView`, false for gc/web), and the window lives only in the `_dvViewMeta` sidecar (`src/runtime.ts` L545, written by `__dv_register_view` L14632). `__arraybuffer_isView` (L16098) re-asks through `_wrapForHost`, which routes the byte vec to the `__is_vec` Array facade → `false`. The first-class VALUE spelling never reaches the import at all: `builtin-value-read.ts` L1234 returns null on the host lane, so `f(dv)` calls the real host `ArrayBuffer.isView` with the same Array mirror.

**Arm that is OFF the table:** `|| _dvViewMeta.has(arg)` in the import. Buffer and view are the SAME struct, so `const b = new ArrayBuffer(1); new DataView(b); ArrayBuffer.isView(b)` would answer true — regressing test262 `built-ins/ArrayBuffer/isView/arg-is-dataview-buffer.js` (pass on the gc baseline today) and leaving the value spelling wrong (breaking #6415's agreement test).

**Arm to build — give the host-lane DataView its own carrier, the standalone `$__dv_window` brand:**
1. `new-indexed.ts`: make the `$__dv_window {buf, byteOffset, byteLength, proto}` wrap unconditional (drop the `windowed = nativeDataView` gate; keep the `ref.test i32_byte` passthrough for non-vec buffers). Keep `__dv_register_view` for now but key it on the WINDOW struct, not the buffer, so the buffer stays unregistered (this alone fixes `arg-is-dataview-buffer` aliasing in `_byteVecByteLength` too).
2. Exports (`src/codegen/vec-access-exports.ts`, next to `__dv_byte_len` ~L1466; register in `host-bridge-exports.ts` and `init-marshal-registry.ts`): `__dv_window_buf(externref)->externref` (buf or null), `__dv_window_attr(externref, i32 sel)->i32` (0 offset / 1 length, −1 when not a window). Module-init census: add both to the marshal-registry list so the `#5203` init window still resolves them.
3. Runtime helper `_dvUnwindow(v, exports) → {buf, offset, length} | undefined` in `src/runtime.ts`; thread it through every `_dvViewMeta`/`__dv_byte_len` consumer that can now receive a window: `_byteVecByteLength` (L961), the `__extern_method_call` DataView fallback (L10955: build the real `DataView` from `buf`, honour `offset/length`), `__dv_view_byte_attr` (L14650), the L665/L898/L11520/L18225 byte-vec readers, `__detach_buffer` (L14673, detach via the unwrapped buf), `property-access-dispatch.ts` L1040 arm (`dv.buffer` must return the unwrapped buf; `byteLength`/`byteOffset` may now reuse the native `winBranch` at L988 instead of the host helper).
4. `_wrapForHost` (L8446): before the `__is_vec` facade, `if (_dvUnwindow(obj))` return a cached real `DataView` over the canonical host ArrayBuffer of `buf` (#3097 `_hostBufferFor`-style, `_compiledTypedArrayMirror` L592 is the template; register reverse-unwrap in `_hostProxyReverse`). This is what makes the VALUE spelling and `makeDataView()` crossing out answer true; the import at L16098 then needs no change.
5. `isViewRefTestInstrs` already covers `$__dv_window`; on the host lane the direct call keeps the import (host-built views + `$Vec` brand) — no codegen change there.

**Order-preservation:** the window wrap must happen AFTER offset/length validation and the `__dv_register_view` call (funcIdx-capture ordering — `ensureLateImport` + `flushLateImportShifts` before the receiver compile, as L988–L1000 does). Keep `_dvViewMeta` keyed on the window during transition; delete the buffer-keyed reads only once every consumer goes through `_dvUnwindow`.

**Probe first:** `.tmp/6433/probe.mts` (exists — reuse) plus a WAT dump of `makeDataView` to confirm the `struct.new $__dv_window` lands on gc/web, then re-run `npm test -- tests/issue-5150* tests/issue-3062* tests/issue-1064* tests/issue-3097* tests/issue-5370* tests/issue-6415*` — those pin the consumers in step 3.

**Regression test** `tests/issue-6433-dataview-isview-host-lane.test.ts`, untyped `mod.js` + typed `entry.ts` (shape of `tests/issue-6415-…`): `dvDirect`, `dvValue` (first-class read), `hostDvDirect(new DataView(...))`, `bufAndView` (buffer with a view on it → `not-view`, the aliasing control), `u8Direct`/`arrDirect`/`objDirect` anti-vacuity, plus `dv.getUint8/setUint8/byteLength/byteOffset/buffer` round-trips through the window. Expected: 2 fail / 7 pass on parent (`dvDirect`, `dvValue`), 9/9 with fix; record exact counts.

**test262 expectation (gc lane):** `ArrayBuffer/isView/arg-is-dataview.js` and `invoked-as-a-fn.js` fail→pass; `arg-is-dataview-buffer.js`, `arg-is-arraybuffer.js` must stay pass; the `built-ins/DataView/**` bucket is the blast radius — diff it in the merge-group report before trusting green PR checks. **Standalone lane:** unchanged by design (it already mints `$__dv_window`); the new exports are host-bridge only. **Dogfood:** no anchor movement expected (jsdom/axios/hono call `isView` on host values); re-run jsdom 6 and axios 208/231 as the tripwire.

## Dispatch

Model: **fable** — a carrier-representation change on the host lane (buffer ≠ view identity) that touches ~8 runtime consumers, the #3097 canonical-buffer mirror and the module-init marshal census, with a test262 aliasing constraint on both sides; re-tag `horizon: m`.
