---
id: 3732
title: "Int16Array/Uint16Array standalone multi-file compile emits an invalid Wasm module"
status: ready
sprint: Backlog
created: 2026-07-28
updated: 2026-07-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: typed-arrays
goal: crash-free
depends_on: []
related: [3707, 3731]
---
# #3732 — `Int16Array`/`Uint16Array` standalone multi-file compile emits an invalid Wasm module

## Context

Found while verifying #3707's fix across TypedArray constructor types.
Independent of #3707/#3731 — reproduces identically with and without that
fix, and is not a trap (it fails `WebAssembly.Module()` validation, i.e. the
compiler emitted structurally invalid bytecode).

## Repro

```ts
export function run(): i32 {
  var sample = new Int16Array([1, 2]);
  sample.set([42], "");
  return sample[0] * 100 + sample[1];
}
```

Compiled via `compileFiles(path, { skipSemanticDiagnostics: true, target:
"standalone" })` (or any other path that reaches `generateMultiModule` —
`compileMulti`/`compileFiles`). The compile itself reports `success: true`
and returns bytes, but `new WebAssembly.Module(result.binary)` throws:

```
WebAssembly.Module(): Compiling function #45:"run" failed:
array.set[2] expected type i32, found array.get of type f64 @+29674
```

Every one of the 16 ECMA-262 `ToInteger`-offset variants in
`array-arg-offset-tointeger.js`-style tests hits this identically for both
`Int16Array` and `Uint16Array` — including the simplest case (`offset: ""`),
so this isn't specific to the object/array-coercion path #3707 fixed. Other
element widths (`Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int32Array`,
`Uint32Array`, `Float32Array`, `Float64Array` — 7 of 9 non-BigInt
constructors) compile and instantiate correctly for the same test shape, so
this looks specific to the 2-byte element width.

## Likely area

`compileTypedArraySet` / `emitArrayCopy` (`src/codegen/array-methods.ts`) or
the i16 element-array `array.set` lowering — the error is a type mismatch
feeding an `array.set` for the destination element array with an `f64`
value where the destination element type wants `i32` (i16 storage arrays are
represented via `i32` fields in WasmGC). Given it reproduces in the
**standalone multi-file** path specifically (not yet checked against
single-file `compile()`/GC-host target — that should be checked first as
part of triage), the bug may be in the same neighborhood as #3731, or may be
a distinct i16-specific coercion bug. Needs triage to confirm which.

## Acceptance criteria

- [ ] Confirm whether this also reproduces via `compile()` (single-file,
      `generateModule`) and/or the JS-host (`gc`) target, to scope which
      backend/path owns the bug.
- [ ] Root-cause the `f64`-vs-`i32` type mismatch feeding the i16 element
      `array.set`.
- [ ] Fix + regression test (mirror `tests/issue-3202.test.ts` /
      `tests/standalone-multimodule-to-primitive-fills.test.ts` patterns).
