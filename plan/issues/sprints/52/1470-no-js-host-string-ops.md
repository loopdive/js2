---
id: 1470
sprint: 52
title: "host-independence: eliminate JS host string ops for standalone Wasm"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: strings
goal: host-independence
related: []
---

# #1470 — Eliminate JS host string ops for standalone Wasm

## Problem

The compiler still emits dependencies on JS-hosted string machinery that are
unavailable when the produced module is run on a pure Wasm engine (wasmtime,
wasmer, browsers without `wasm:js-string` builtins, WASI). The native-strings
backend (#679) implements `$AnyString` / `$FlatString` / `$ConsString` and a
suite of WasmGC helpers (`__str_concat`, `__str_slice`, …) in pure Wasm, but
the following surfaces still escape into JS:

1. **`wasm:js-string` import** (`src/runtime.ts` line 1718, exposed via
   `jsString = { concat, length, equals, substring, charCodeAt }`).
   In non-native-strings mode every string operation goes through these JS
   functions; under WasmGC native-strings the helpers still call
   `wasm:js-string.concat` for cross-mode interop and as the externref
   fallback.

2. **`__concat_N` host imports** (`runtime.ts` line 1950 —
   `name.startsWith("__concat_")`): batched string concatenation
   (`__concat_3`, `__concat_4`, …) emitted by the template-literal /
   chained-`+` codegen routes through JS `String(a) + String(b)` when any
   operand is externref. Created in `string-ops.ts` (#958).

3. **`__str_extern_len` / `__str_from_mem` / `__str_to_mem`**
   (`runtime.ts` 4492–4514): WASI memory-marshal helpers that *still* use
   JS `TextEncoder` / `TextDecoder` to round-trip between externref strings
   and the linear memory used for `fd_write`. The Wasm side has no path to
   produce or consume UTF-8 bytes without going through these.

4. **`__extern_toString`, `__extern_toLocaleString`** (`runtime.ts` 2402,
   2430): produce a string from any externref. Invoked from
   `coerceType` (ref→string), `String(x)`, template literals on
   externref operands.

5. **`__unbox_string`** (`runtime.ts` 2530) — extracts primitive from a
   String wrapper object; used by codegen whenever an externref enters a
   string context.

6. **string-method imports** (`string_method` intent, `runtime.ts` 1799+):
   any `s.method(...)` that wasn't lowered to a native string helper
   (notably `String.prototype.normalize`, `localeCompare`, `toLowerCase`
   /`toUpperCase`, `padStart`, `padEnd`, `matchAll`, locale-aware
   methods) is emitted as a JS `s[method](...args)` host call.

Why this blocks standalone: wasmtime instantiation fails with
`unknown import: env::__concat_3` (and friends) the moment any compiled
module contains a non-trivial template literal or any string method
beyond the native helpers list. The user can't ship the resulting
`.wasm` outside a JS host.

## Standalone alternative

The compiler already proves the design works (#679 native-strings):
WasmGC `array (mut i16)` payload, `struct $FlatString {len, offset,
data}`, `struct $ConsString {len, left, right}`. Extend that backend so
the JS host imports become unreachable:

- **`__concat_N`**: rewrite the codegen in `string-ops.ts` to chain
  native `__str_concat` calls (left-associative cons-chain). Already
  partially done for native strings; do it unconditionally when the
  target is WASI or `--no-js-host` is set.
- **`__extern_toString` ref→string**: emit a WasmGC `__any_to_string`
  helper that switches on type (i31ref number → digits via Grisu/Ryu,
  ref `$FlatString` passthrough, ref `$AnyVec` → `[object Array]`-style
  serialization, etc.). Wasmtime ships no JS — every branch must be in
  Wasm.
- **`__str_from_mem` / `__str_to_mem`**: replace `TextEncoder` with a
  pure-Wasm UTF-8 encoder/decoder over the `array i16` payload (UTF-16
  → UTF-8 fold loop, 7 instructions per code-unit in the BMP fast
  path; well-known surrogate-pair handling for SMP).
- **`String.prototype.normalize` / `toLowerCase` / `toUpperCase` /
  `localeCompare`**: ship an ICU-lite static table baked into the
  module (only the Default Unicode Case Algorithm, ~30 KB) when the
  user enables `--full-unicode`; without it, fall back to ASCII-only
  case folding (zero-cost). Tracked separately (#640-family) but
  this issue covers the import surface.
- **`__unbox_string`**: when the source-level type is statically
  known to be a string primitive (TypeScript `string`), elide the
  host call entirely and emit `ref.cast $FlatString` instead. The
  remaining dynamic cases need a Wasm-side `__any_to_string` (same
  helper as `__extern_toString`).
- **`wasm:js-string` polyfill**: when targeting WASI / `--standalone`,
  do NOT import the `wasm:js-string` namespace at all — emit native
  helpers exclusively.

## Acceptance criteria

- [ ] A new CLI flag `--no-js-host` (or `--standalone`) emits a module
      whose import section contains zero `env::__concat_*`,
      `env::__extern_toString`, `env::__extern_toLocaleString`,
      `env::__unbox_string`, `env::string_method_*`, and no
      `wasm:js-string` namespace.
- [ ] `npm run build && wasmtime run examples/string-basics.wasm`
      passes for: template literals (`` `hi ${name}` ``), chained `+`,
      `s.length`, `s.slice`, `s.charCodeAt`, `s.indexOf`,
      `s.startsWith`, `s.split` (returns vec), `String(n)` for numeric
      `n`.
- [ ] WASI mode (`--target wasi`) implicitly enables this — current
      WASI build that still imports `__str_from_mem` falls back to the
      pure-Wasm UTF-8 path.
- [ ] Equivalence tests (`tests/equivalence.test.ts`) for all
      currently-passing string examples remain green under both
      `--js-host` (default) and `--standalone`.
- [ ] Test262 `built-ins/String/prototype` pass rate must not regress
      in default mode; standalone-mode subset (no `normalize`,
      `localeCompare`) is tracked separately.

## Files to modify

- `src/codegen/string-ops.ts` (lines ~170, 887, 1429) — gate
  `__str_concat` / `__str_slice` to ALWAYS native when standalone;
  remove `__concat_N` codegen path.
- `src/codegen/native-strings.ts` (lines 500, 1065, 2023) —
  add `__any_to_string`, pure-Wasm UTF-8 encode/decode helpers; ensure
  `__str_concat` handles externref-tagged operands by upcasting via
  `ref.cast $AnyString` only.
- `src/codegen/type-coercion.ts` (lines ~1296–1410) — replace
  `__extern_toString` calls with the new `__any_to_string` helper.
- `src/runtime.ts` (lines 1718, 1950, 4492, 4514, 2402, 2530) — leave
  these for JS-host mode but make them dead code in standalone.
- `src/codegen/index.ts` (around 3558) — add a `standalone` flag that
  refuses to register any of the above imports.
- `tests/standalone.test.ts` (new) — wasmtime smoke tests.
