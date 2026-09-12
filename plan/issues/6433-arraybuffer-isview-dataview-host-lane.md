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
