---
id: 1598
title: "host-indep: pure-Wasm String.fromCharCode / fromCodePoint in standalone mode"
status: done
completed: 2026-06-12
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: string built-ins
goal: standalone-wasm
sprint: 55
related: [1471, 1474]
---
# #1598 — Pure-Wasm `String.fromCharCode` / `String.fromCodePoint` in standalone mode

## Problem

`String.fromCharCode` has no standalone path at all (`declarations.ts:1002`).
`String.fromCodePoint` has a `--nativeStrings` path (pure-Wasm helper) but falls
back to a host import when `nativeStrings` is false (`declarations.ts:1013`).

In `--target standalone` mode without `--nativeStrings`, both register
`env::String_fromCharCode` / `env::String_fromCodePoint` host imports, which fail
at instantiation under wasmtime.

## Current gating (`declarations.ts:1002–1016`)

```ts
if (state.needsFromCharCode) {
  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
  // no ctx.standalone check
}
if (state.needsFromCodePoint) {
  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);  // ✓ handled
  } else {
    addImport(ctx, "env", "String_fromCodePoint", ...);  // no ctx.standalone check
  }
}
```

## Fix

### `String.fromCharCode` (standalone path)

`fromCharCode` takes one or more UTF-16 code unit values (f64, coerced to u16)
and returns a string. In standalone mode (WasmGC, non-nativeStrings), emit a
pure-Wasm helper that allocates an `(array i16)` and fills it:

```wat
;; __fromCharCode(code: f64) -> (ref $StringArr)
(func $__fromCharCode (param $code f64) (result (ref $StringArr))
  (array.new $StringArr
    (i32.trunc_f64_u (local.get $code))
    (i32.const 1)
  )
)
```

Multi-argument form: collect args into a local array, write each code unit.
The single-argument fast path covers the vast majority of real uses.

### `String.fromCodePoint` (standalone path, non-nativeStrings)

`fromCodePoint` takes Unicode code points (may require surrogate pairs for
codepoints > 0xFFFF). In standalone mode, emit a pure-Wasm helper:

1. If `codePoint <= 0xFFFF`: same as `fromCharCode` — single `(array i16)` element.
2. If `codePoint > 0xFFFF` (supplementary): allocate length-2 array, compute
   surrogate pair (`(cp - 0x10000)`), write high and low surrogates.

This logic is ~30 lines of Wasm helpers, already approximated by the
`ensureNativeStringHelpers` path — standalone can reuse or mirror it.

## Files

- `src/codegen/declarations.ts` lines 1002–1016 — add `ctx.standalone` branch
- `src/codegen/wasm-helpers/string-statics.ts` (new, or add to existing string helpers)
  — `emitFromCharCode(ctx)` and `emitFromCodePoint(ctx)` Wasm helper emitters

## Acceptance criteria

- `String.fromCharCode(65)` returns `"A"` in standalone mode.
- `String.fromCodePoint(0x1F600)` returns the emoji in standalone mode
  (correct surrogate pair).
- No `env::String_fromCharCode` or `env::String_fromCodePoint` in standalone output.
- JS-host mode: no change.

## Effort

~60 LOC (Wasm helper emitters + registration branch). No new WasmGC types needed.
