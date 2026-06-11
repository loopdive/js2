---
id: 1470
title: "host-independence: eliminate JS host string ops for standalone Wasm"
status: done
created: 2026-05-20
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: strings
goal: host-independence
sprint: 61
model: fable
related: []
pr: 1283
claimed_by: codex-developer
claimed_at: 2026-06-07T10:02:25.296Z
completed: 2026-06-11
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

## Implementation Plan

### Root cause
Compiled modules still register five families of `env::*` imports for string
work even when `ctx.wasi === true`. The native-strings backend (`src/codegen/
native-strings.ts`) implements `$AnyString` / `$FlatString` / `$ConsString` +
`__str_concat` / `__str_slice` / `__str_equals` / `__str_compare` purely in
WasmGC, but the rest of codegen still falls back to `ensureLateImport()` for
batched concat (`__concat_N`), ref→string (`__extern_toString`), externref
unbox (`__unbox_string`), externref↔linear-memory marshal (`__str_from_mem`,
`__str_to_mem`, `__str_extern_len`), and the catch-all `string_method`
intent. Each is fatal to `wasmtime run`.

### New CLI flag and ctx flag

1. **`src/cli.ts` line 70–85**: add a new target value `"standalone"` to the
   `--target` option (`gc | linear | wasi | standalone`). `standalone`
   targets pure WasmGC with no JS host *and* no WASI runtime.

2. **`src/index.ts` lines 97–104** (`CompileOptions`): widen the
   `target` field union to include `"standalone"`. Document that
   `target: "standalone"` implies `nativeStrings: true` and a strict
   "no JS host imports" assertion at module emit time.

3. **`src/codegen/context/types.ts`**: add a new boolean field
   `standalone: boolean` adjacent to `wasi` (~line 587). Default false.

4. **`src/codegen/context/create-context.ts`** (~line 132): set
   `standalone: options?.target === "standalone"`. Also: when
   `options.target === "standalone"`, force `nativeStrings: true` at line
   89 (the existing default-resolution chain).

Wherever code currently reads `ctx.wasi`, audit whether the intent is
"WASI runtime" (e.g., fd_write availability) vs "no JS host"
(e.g., the cases below). For the cases below, use
`const noJsHost = ctx.wasi || ctx.standalone;`. WASI mode already
forbids the JS host, so the two flags collapse for string codegen.

### Per-import changes

**(1) `__concat_N` — `src/codegen/string-ops.ts` line 838–865**

Replace `compileBatchedConcat()` body when `noJsHost` is set:

```ts
function compileBatchedConcat(ctx, fctx, operands): ValType {
  const noJsHost = ctx.wasi || ctx.standalone;
  if (noJsHost) {
    // Ensure native-string helpers are registered
    ensureNativeStringHelpers(ctx);
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    // Left-fold cons-chain: emit ops[0], coerce; then for each subsequent:
    //   compile op_i, coerce to ref $AnyString, call __str_concat
    compileAndCoerceConcatOperandNative(ctx, fctx, operands[0]);
    for (let i = 1; i < operands.length; i++) {
      compileAndCoerceConcatOperandNative(ctx, fctx, operands[i]);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
    return nativeStringType(ctx);
  }
  // ... existing __concat_N path unchanged for JS-host mode
}
```

`compileAndCoerceConcatOperandNative` is a new helper that mirrors the
existing `compileAndCoerceConcatOperand` (line ~785) but coerces the
operand to `ref $AnyString` via `__any_to_string` (see (4) below) rather
than to externref. For an operand already of native-string type, no
coercion is needed.

**(2) `__extern_toString` — replace with Wasm-native `__any_to_string`**

Add a new helper in `src/codegen/native-strings.ts` (next to
`ensureNativeStringExternBridge`, ~line 2950):

```ts
/**
 * Emit `$__any_to_string(v: anyref) -> ref $AnyString` — the standalone
 * replacement for the `__extern_toString` host import. Dispatches on the
 * concrete WasmGC type of `v`:
 *   - ref $AnyString  → ret as-is
 *   - ref i31         → format integer
 *   - ref $BoxedNumber→ format f64 (Grisu or simple itoa fallback)
 *   - ref $Object     → walk vtable for [[ToString]] / "[object Object]"
 *   - null / undefined→ "null" / "undefined"
 */
export function ensureAnyToStringHelper(ctx: CodegenContext): number {
  // Idempotent; populates ctx.nativeStrHelpers["__any_to_string"]
}
```

`compileAndCoerceConcatOperandNative` calls `ensureAnyToStringHelper`
then `call $__any_to_string`. Phase-1 implementation can fall back to
the existing `__num_to_str` helper for numbers (already in
native-strings.ts) and `"[object Object]"` for refs whose toString
isn't statically known. Spec-correct dispatch (look up `@@toPrimitive`
/`toString` via vtable) lands with #1472.

Call-site replacements (replace `ensureLateImport("__extern_toString",
…)` with `ensureAnyToStringHelper(ctx)` guarded by `noJsHost`):

- `src/codegen/expressions/calls-closures.ts:299, 312`
- `src/codegen/expressions/calls.ts:4930, 4943`
- `src/codegen/type-coercion.ts` ref→string path (~line 1296–1410)

**(3) `__str_from_mem` / `__str_to_mem` / `__str_extern_len` —
pure-Wasm UTF-8 codec — `src/codegen/native-strings.ts:2950–3050`**

The three imports exist because `ensureNativeStringExternBridge`
needs to bridge `ref $FlatString` (UTF-16) ↔ JS externref strings via
linear-memory UTF-8 (used by `fd_write`).

When `noJsHost`, replace the three imports with three in-module
Wasm functions:

```
$__utf16_to_utf8(s: ref $FlatString, dstPtr: i32) -> i32  ;; bytes written
$__utf8_to_utf16(srcPtr: i32, byteLen: i32) -> ref $FlatString
$__utf16_byte_len(s: ref $FlatString) -> i32              ;; UTF-8 length
```

UTF-8 encoder for code unit `cu` at offset `i`:

```wat
local.get $cu
i32.const 0x80
i32.lt_u
if  ;; 1-byte ASCII fast path
  local.get $dst
  local.get $cu
  i32.store8
  ;; advance dst by 1
else
  local.get $cu
  i32.const 0x800
  i32.lt_u
  if  ;; 2-byte (110xxxxx 10xxxxxx)
    local.get $dst
    local.get $cu
    i32.const 6
    i32.shr_u
    i32.const 0xC0
    i32.or
    i32.store8
    ;; second byte
    local.get $dst i32.const 1 i32.add
    local.get $cu
    i32.const 0x3F
    i32.and
    i32.const 0x80
    i32.or
    i32.store8
    ;; advance dst by 2
  else
    ;; 3-byte (or surrogate pair → 4-byte). Check 0xD800-0xDBFF for high
    ;; surrogate, peek next code unit, combine into U+10000..U+10FFFF, emit
    ;; 4-byte sequence. Else emit 3-byte 1110xxxx 10xxxxxx 10xxxxxx.
  end
end
```

This is ~60 instructions; see Russ Cox's `utf.c` for the canonical
shape. Cache the result helper indices on `ctx.nativeStrHelpers`
under the keys `__utf16_to_utf8`, `__utf8_to_utf16`,
`__utf16_byte_len`.

Then in `ensureNativeStringExternBridge` (line 2969–2976), branch:

```ts
if (noJsHost) {
  ensureUtf8CodecHelpers(ctx);   // new
  // emit the bridge functions inline calling the codec helpers
  // instead of the JS host imports
} else {
  // existing __str_from_mem / __str_to_mem / __str_extern_len path
}
```

For `wasi` mode that emits `fd_write`, the encoder writes directly
into the WASI iovec buffer at the existing bump-pointer (see
`ctx.wasiBumpPtrGlobalIdx` line 3047).

**(4) `__unbox_string` — `src/codegen/type-coercion.ts` (~line 1180,
also property-access.ts:650, 656)**

Two-pronged retargeting:

- **Static-string fast path** (already partially done): when the TS
  type at the use site resolves to `string`, do NOT call
  `__unbox_string` — emit `ref.cast $FlatString` directly on the
  externref. The codegen knows the static type via
  `ctx.checker.getTypeAtLocation`.

- **Dynamic-any path**: replace `__unbox_string` import with a
  fall-through path that calls `$__any_to_string` (same helper as
  (2)). The ref→string semantics already match ECMA-262
  ToString in the easy cases, and the JS-host path was just
  `String(v)` anyway.

Gate: when `noJsHost`, never call `ensureLateImport("__unbox_string",
…)`. If the use site needs the dynamic ToString, call
`ensureAnyToStringHelper(ctx)`.

**(5) `wasm:js-string` polyfill — `src/codegen/index.ts` ~line 1241**

Already gated: `if (ctx.nativeStrings) return;` for the
`wasm:js-string` import emission. Since `standalone` forces
`nativeStrings: true` (see "New CLI flag" section), no further gate
needed — verify by reading the post-emission imports.

**(6) `string_method` intent — `src/runtime.ts:1799` and
`src/codegen/string-ops.ts:170, 887, 1429`**

Wherever a `String.prototype.<method>` call lands on the
`string_method` intent (the JS-host catch-all), branch on
`noJsHost`. Three buckets:

- **Already native**: `concat`, `slice`, `substring`, `charCodeAt`,
  `indexOf`, `startsWith`, `endsWith`, `includes`, `length`,
  `split`, `repeat`, `trim` — keep using the existing
  `nativeStrHelpers` entries.
- **ASCII-only fallback**: `toLowerCase`, `toUpperCase`, `padStart`,
  `padEnd` — emit a Wasm-native ASCII-only implementation (no
  `wasm:js-string`, no host call). For non-ASCII inputs, fall
  through to a per-codepoint Default Case Algorithm helper (large;
  follow-up issue).
- **Refuse**: `normalize`, `localeCompare`, `matchAll`,
  `toLocaleLowerCase`, `toLocaleUpperCase` — at compile time in
  `standalone` mode, call `reportError(ctx, expr, "String.prototype.<m>
  not supported in --target standalone (#1470)")`. Document in the
  acceptance criteria.

### Test approach

- **Existing**: `tests/equivalence.test.ts` covers template literals,
  concat, slice, etc. — must remain green in both default and
  `--target standalone` modes. Add a new test runner mode that
  recompiles each fixture with `target: "standalone"` and runs the
  resulting `.wasm` under wasmtime via `child_process.spawnSync`
  (mirror the existing `tests/wasi*.test.ts` runner).
- **New**: `tests/standalone-strings.test.ts` (replaces the issue's
  proposed `tests/standalone.test.ts`):
  - Template literal: `` `hi ${name}` `` with `name: string`
  - Chained `+`: `"a" + n + "b"` with `n: number`
  - `String.prototype.{length, slice, charCodeAt, indexOf,
    startsWith, repeat, split, trim}`
  - `String(42)`, `String(true)`, `String(null)`,
    `String(undefined)`
- **Import-section assertion**: a helper that parses the output
  `.wasm` import section and asserts zero entries from `env::__concat_*`,
  `env::__extern_toString*`, `env::__unbox_string`,
  `env::__str_from_mem`, `env::__str_to_mem`,
  `env::__str_extern_len`, `env::string_method_*`,
  and no `wasm:js-string` namespace. Add as a shared helper
  `tests/helpers/assert-no-js-host-imports.ts` used across #1470-1474.
- **Test262**: re-run `built-ins/String/prototype/{slice,
  charCodeAt, indexOf, startsWith, includes, split, repeat,
  trim}` subset in standalone mode; track regressions in
  dashboard.

### Dependency ordering

1. **Lands first** — the CLI flag + ctx flag plumbing (above) is a
   no-op refactor that lets the other four issues key off
   `ctx.standalone`.
2. After (1): `__concat_N` → native concat, and `__any_to_string`
   stub helper (returns `"[object Object]"` for refs); this unblocks
   `wasmtime run` for simple template-literal samples.
3. After (2): UTF-8 codec helpers (largest piece, but isolated).
4. Last: full `__unbox_string` retargeting and the
   `string_method` policy (depends on #1472 for vtable-driven
   toString dispatch).

This issue **must land before #1471, #1472, #1473** in terms of CLI
plumbing — those four reuse the new `ctx.standalone` flag and the
import-section assertion helper. The Wasm-native body of each can
land in parallel.

## Progress / Test Results

### 2026-06-04 — `__any_to_string` + mixed-operand native concat (dependency step 2)

Implemented the pure-Wasm `$__any_to_string(anyref) -> ref $AnyString`
dispatcher (`src/codegen/native-strings.ts`, `ensureAnyToStringHelper`)
and wired the native string-concat / template-substitution paths to use
it under `noJsHost` (WASI / `--target standalone`):

- **Root cause fixed**: the native `+`-concat path
  (`compileStringBinaryOp`, `PlusToken`) and template substitution pushed
  the **raw** operand (`f64` / `i32` / struct ref) straight into
  `__str_concat`, which expects `(ref $AnyString, ref $AnyString)`. Any
  non-string operand produced an **invalid module** (`call expected
  (ref null N), found local.get of type i32`) — every standalone module
  with `"x" + n`, `+ boolean`, `+ object`, or numeric template
  substitution failed `WebAssembly.instantiate` / `wasmtime run`.
- **Fix** (`src/codegen/string-ops.ts`, new `compileNativeConcatOperand`,
  gated on `noJsHost(ctx)`): each operand is lowered to a native
  `ref $AnyString` in pure Wasm — numbers via the native `number_toString`
  helper, booleans/null/undefined via native literals, dynamic `any` /
  object refs via `$__any_to_string`. The legacy JS-host `nativeStrings`
  path (`fast` / explicit `nativeStrings: true`) is left on its original
  raw-push behavior (its mixed-operand handling has separate, pre-existing
  limitations; bridging via `__str_from_extern` mid-body shifts function
  indices).
- **`$__any_to_string` dispatch** (Phase 1): `ref.test $AnyString` →
  passthrough; `$AnyValue` box → tag dispatch (null/undefined/number/
  bool/string); else → `"[object Object]"`. Spec-correct vtable
  `toString`/`@@toPrimitive` dispatch for ordinary objects remains
  deferred to **#1472**.

**Verified** (compiled `--target standalone`, instantiated with an empty
import object, zero JS-host string imports, value read back via
`s.length` / `s.charCodeAt`):

| expression                              | result            |
|-----------------------------------------|-------------------|
| `"n=" + (42 as number)`                 | `n=42`            |
| `"f=" + (-3.5 as number)`               | `f=-3.5`          |
| `"b=" + true` / `+ false`               | `b=true`/`b=false`|
| `"a" + 3 + "b" + 4`                     | `a3b4`            |
| `` `val ${7}` ``                        | `val 7`           |
| `"v=" + ("hi" as any)`                  | `v=hi`            |
| `"n=" + (5 as any)`                     | `n=5`             |
| `"o=" + ({a:1} as any)`                 | `o=[object Object]`|

Tests: `tests/issue-1470-standalone-string-imports.test.ts` (14 passing —
6 original import-section guards + 8 new behavioral cases that
instantiate and read back values). `native-strings`,
`native-strings-standalone`, `native-strings-roundtrip`, `issue-1759`,
`issue-1321/1335-standalone`, `wasi-stdout` suites all green; the
default (`gc`) and `fast`/`nativeStrings` host paths are unchanged.

**Known Phase-1 limitations (deferred):**
- A boolean boxed via `x as any` reads back as `1`/`0` rather than
  `true`/`false` (the `$AnyValue` boxing site tags it as a number — a
  boxing concern, not a ToString-dispatch one).
- `null as any` / `undefined as any` literal substitutions in a template
  still produce an invalid module (the `X as any` literal lowering emits
  a typed `ref.null` while reporting kind `externref`); realistic
  `null`/`undefined`-typed variables work.
- `undefined`-literal lowering still pulls `env::__get_undefined`
  (unrelated to string codegen; separate standalone-leak).

**Still open for #1470** (later PRs): pure-Wasm UTF-8 codec
(`__str_from_mem`/`__str_to_mem`), full `__unbox_string` retargeting, the
`string_method` ASCII-fold / refuse policy, and the spec-correct object
`toString` dispatch (via #1472).

### 2026-06-04 — `String(null/undefined/bool)` + no-arg `String()` standalone fix

The `String()` builtin call handler (`src/codegen/expressions/calls.ts`
~L7745) and the shared `emitBoolToString` helper (`src/codegen/string-ops.ts`
~L900) pushed `global.get` of a JS-host string-constant global
(`addStringConstantGlobal`) for the literal arms — `String()`, `String(null)`,
`String(undefined)`, `String(<void>)`, and `String(<bool>)` /
`bool.toString()`. Those globals are **never registered** in native-strings
mode, so the index resolved to the `-1` sentinel (`4294967295`) and the module
failed `WebAssembly.instantiate` / `wasmtime run` with **"Invalid global index:
4294967295"** under `--target standalone` / `--target wasi`.

- **Fix**: route every literal arm through `compileStringLiteral`, which
  already branches on `ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0` and
  materializes a `NativeString` GC struct inline (no host global). Made
  `emitBoolToString` native-aware the same way (returns the selected
  `NativeString` ref in native mode, the externref global in JS-host mode) and
  threaded its return type back through both call sites so the result type
  stays consistent. JS-host (`gc`) mode is unchanged — `compileStringLiteral`
  still emits the externref `global.get` there.
- **Side benefit**: the explicit `nativeStrings: true` ("fast-native") path,
  which previously hit the same unbound-global defect for boolean concat /
  `String(bool)`, now also works.

**Verified** (compiled `--target standalone` + `wasi`, instantiated with an
empty import object, read back via `.length`/`.charCodeAt`):

| expression          | result      |
|---------------------|-------------|
| `String(true)`      | `"true"`    |
| `String(false)`     | `"false"`   |
| `String(null)`      | `"null"`    |
| `String(undefined)` | `"undefined"`|
| `String()`          | `""`        |
| `String(42)`        | `"42"`      |
| `b.toString()` (bool)| `"true"`   |

Tests: `tests/issue-1470-string-coercion-standalone.test.ts` (4 cases —
standalone + WASI + gc-default regression + explicit nativeStrings).
`native-strings`, `native-strings-standalone`,
`issue-1470-standalone-string-imports` (14) all green; default `gc` JS-host
path unchanged.

### 2026-06-07 — WASI runtime strings encode UTF-8 without JS-host bridge

Replaced the WASI `__wasi_write_any_string` runtime-string writer's low-byte
copy loop with an in-module WTF-16 to UTF-8 encoder. Runtime strings are still
flattened via `__str_flatten`, but their code units are now encoded directly
into the fd_write scratch buffer and the actual UTF-8 byte cursor is used as
the iovec length. This keeps `process.stdout.write(str)`,
`process.stderr.write(str)`, and `console.log(runtimeString)` on the pure-Wasm
path without registering `__str_from_mem`, `__str_to_mem`, or
`__str_extern_len`.

Added `tests/issue-1470.test.ts` to capture raw WASI fd_write bytes for a
runtime-built non-ASCII string (`U+00E9` plus an astral surrogate pair). The
old writer produced truncated/invalid bytes; the new path matches UTF-8 and
still emits no JS-host string bridge imports.

Validation:
- `pnpm exec vitest run tests/issue-1470.test.ts`
- `pnpm exec vitest run tests/issue-1470-standalone-string-imports.test.ts tests/issue-1470-string-coercion-standalone.test.ts tests/issue-1759.test.ts tests/issue-1618-1651-wasi-stdout.test.ts`
- `pnpm exec prettier --check src/codegen/index.ts tests/issue-1470.test.ts`
- `pnpm exec biome lint src/codegen/index.ts tests/issue-1470.test.ts --diagnostic-level=error`
- `pnpm exec tsc --noEmit --pretty false`

### 2026-06-07 — Attempt 30 publish refresh

PR #1283 is open and ready against `main`. Merged current `origin/main`
(`28c668ab4`) into `symphony/1470` after the previous PR head had a failed
Test262 Sharded `merge shard reports` job, leaving the diff scoped to
`src/codegen/index.ts`, `tests/issue-1470.test.ts`, and this issue file.

Post-merge validation:
- `pnpm exec vitest run tests/issue-1470.test.ts`
- `pnpm exec vitest run tests/issue-1470-standalone-string-imports.test.ts tests/issue-1470-string-coercion-standalone.test.ts tests/issue-1759.test.ts tests/issue-1618-1651-wasi-stdout.test.ts`
- `pnpm exec prettier --check src/codegen/index.ts tests/issue-1470.test.ts`
- `pnpm exec biome lint src/codegen/index.ts tests/issue-1470.test.ts --diagnostic-level=error`
- `pnpm exec tsc --noEmit --pretty false`

### 2026-06-10 — residual sweep: string iteration + localeCompare + toLocale case

Behavioral probe of all string surfaces under `--target standalone` (45-case
battery, compared against real JS evaluation) found the remaining defects were
not import *leaks* — the import section was already clean for every probed op
— but silently-wrong or invalid lowerings on the **String-iteration** and
**string_method-fall-through** paths:

1. **`[...str]` produced an empty array** (`[..."abc"].length === 0`,
   elements null). Root cause: `compileArrayLiteralWithSpread`
   (`src/codegen/literals.ts`) pushed the native-string struct into the
   generic vec-spread branch; `getArrTypeIdxFromVec` fails for the string
   type and the branch silently `continue`d — the spread contributed
   nothing while the result vec's `len` stayed 0.
2. **`Array.from(str)` emitted an INVALID module** under standalone: the
   string argument fell to the `__array_from` JS-host fallback (#965),
   which both leaks `env::__array_from` and corrupted `__str_flatten`'s
   body through the late-import shift ("call[0] expected (ref null 5),
   found i32.const").
3. **for-of / IR `forof.string` iterated code UNITS** — §22.1.5.1 String
   iteration yields code POINTS (a surrogate pair is one 2-unit element).
   Both the legacy `compileForOfString` (loops.ts) and the IR lowering
   (`src/ir/lower.ts` `forof.string`) advanced by a fixed +1.
4. **`localeCompare` always returned 0** — fell through to "Unknown string
   method", demoted to a `f64.const 0` stub. Violates §22.1.3.12's
   consistency requirement (everything compared "equal").
5. **`toLocaleLowerCase`/`toLocaleUpperCase`** hit the same numeric-zero
   stub.

**Fixes (pure Wasm, no new imports):**
- New `$__str_to_char_vec(s: ref $AnyString) -> ref $vec_nstr` helper
  (`src/codegen/native-strings.ts`, `ensureStrToCharVecHelper`) — the
  §22.1.5.1 materializer; reuses `__str_split`'s `ref_<anyStr>` vec
  registration so the result IS the `string[]` shape. Wired into the
  array-literal spread path and a new `Array.from(string)` fast path
  (`src/codegen/expressions/calls.ts`, tentative-compile + rollback per the
  #1610 pattern). Spread element-type inference now maps a string spread
  source to the nstr element type.
- New `$__str_charAt_cp(s, idx)` helper (registered with the main suite,
  right after `__str_charAt`) — code-point charAt returning the whole pair.
  The IR `forof.string` lowering calls it and advances the cursor by the
  element's `len` (no new slots needed). The legacy `compileForOfString`
  flattens once up front and does the surrogate check inline on the raw
  code units (also removes the per-iteration re-flatten).
- `localeCompare` lowers to the native `__str_compare` (-1/0/1, UTF-16
  code-unit order — a valid §22.1.3.12 implementation-defined consistent
  total order absent ECMA-402); locales/options args evaluated + dropped.
- `toLocale{Lower,Upper}Case` alias the default case-fold arm.

**Verified:** `[..."a😀b"].length === 3` (middle element len 2),
`Array.from("abc")` native vec (no env imports, empty-import instantiate),
for-of yields pairs as one element in BOTH IR and legacy paths, lone
surrogates stay separate, localeCompare total order matches `<`. Tests:
`tests/issue-1470-string-iteration-standalone.test.ts` (8 cases:
standalone + WASI parity + gc-host regression guard).

**Known remaining (documented, deferred):**
- Non-ASCII case folding (`"À".toLowerCase()` is identity) and
  `normalize()` composition (identity) need Unicode tables — the issue's
  `--full-unicode` follow-up (#640-family). Both are *silent-identity*, not
  import leaks.
- gc / JS-host mode `[..."abc"]` returns an empty array on main too
  (pre-existing host-mode gap in the externref spread branch's
  `__extern_length` on a JS string) — out of #1470's standalone scope,
  needs its own issue.
- Standalone `Array.from(<non-string non-array iterable>)` still falls to
  the `__array_from` host fallback — owned by the #1320 iterator bridge.
