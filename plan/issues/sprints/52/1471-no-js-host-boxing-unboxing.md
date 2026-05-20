---
id: 1471
sprint: 52
title: "host-independence: eliminate JS host boxing/unboxing for standalone Wasm"
status: in-progress
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: numbers, booleans, any-typed values
goal: host-independence
related: []
---

# #1471 — Eliminate JS host boxing/unboxing for standalone Wasm

## Problem

Almost every dynamic-typed value crossing a boundary in compiled code
funnels through JS-hosted boxing helpers. Without a JS runtime these
imports cannot be satisfied and the module fails to instantiate.

Imports currently with **no standalone fallback**:

1. **`__box_number`** (`src/runtime.ts` `case "box"` line 4551,
   registered unconditionally at `codegen/index.ts:4913`).
   Signature `(f64) -> externref`. Implemented in JS as the identity
   (`(v) => v`) — V8 auto-boxes the `Number` at the ABI boundary.
   No Wasm-side equivalent exists.

2. **`__unbox_number`** (`runtime.ts` line 4553 `case "unbox"`,
   registered at `codegen/index.ts:4900`). Signature
   `(externref) -> f64`. JS uses full `_hostToPrimitive` →
   `Number(prim)` which can invoke user `valueOf`/`toString`
   /`@@toPrimitive`, including dispatching Wasm closures back into
   the module. Pure-Wasm engines have no `Number()`.

3. **`__box_boolean`** / **`__unbox_boolean`** (`codegen/index.ts`
   lines 4906, 4917) — same shape as numeric boxing.

4. **`__box_symbol`** (`runtime.ts` line 2484) — interns the
   well-known-symbol ID → real JS Symbol map. Wasm side cannot
   produce a Symbol without a host.

5. **`__to_primitive`** (`runtime.ts` line 2475) — full ECMA-262
   §7.1.1 ToPrimitive over an externref. Invoked from
   `type-coercion.ts` line 138 whenever an externref must collapse
   to a primitive (number/string contexts on `any`).

6. **`__to_boolean`** (`runtime.ts` line 2463) — ECMA-262 §7.1.2
   ToBoolean. Trivial in JS (`(v) => v ? 1 : 0`), but the externref
   value can be any host shape including Symbols and zero-length
   strings that the Wasm side cannot inspect without unboxing first.

7. **`__typeof`** (`runtime.ts` 4446) and the `__typeof_number`
   /`__typeof_string` / `__typeof_boolean` / `__typeof_undefined`
   /`__typeof_object` / `__typeof_function` family (`codegen/index.ts`
   4870–4890) — the typeof check on an opaque externref needs the JS
   `typeof` operator.

8. **`__to_uint32`** / **`__toUint32`** (`runtime.ts` 4490) — bit-ops
   convert externref operands through JS `>>>0`.

Why this blocks standalone: every `let x: any = …`, every `+`/`*`/`-`
between possibly-externref operands, every `if (x)` on an `any`
binding, and every `typeof x === "string"` test currently expands to
a host call. The compiled `.wasm` rejects on instantiation under
wasmtime ("unknown import env::__unbox_number").

## Standalone alternative

WasmGC + i31ref already provide every primitive in pure Wasm:

- **`__box_number`** → inline `f64.const` followed by `struct.new
  $BoxedNumber {value: f64}` — or skip when the consumer can accept
  a plain f64. For SMI-range integers, use **i31ref** (`ref.i31` /
  `i31.get_s`) — single-instruction box, no allocation, GC-free.
- **`__unbox_number`** → walk a runtime-emitted Wasm dispatcher:
  - if `ref.test i31ref` → `i31.get_s` → `f64.convert_i32_s`
  - else if `ref.test $BoxedNumber` → `struct.get $BoxedNumber 0`
  - else if `ref.test $FlatString` → parse-number Wasm helper
  - else → invoke a Wasm-side `__to_primitive` (see below)
  All branches WasmGC, no host call.
- **`__box_boolean`** → emit a global `$True` / `$False` struct ref
  (singletons) or use i31 with tag bits.
- **`__box_symbol`** → at module-load time materialize the well-known
  symbol structs as Wasm globals (`$SymbolIterator`, …). User
  Symbols (`Symbol("foo")`) need a Wasm-side allocator that produces
  unique GC structs; the JS-side `Symbol()` identity guarantee can
  be reproduced by struct identity (every allocation a fresh ref).
- **`__to_primitive`** → ported §7.1.1 in pure Wasm: look up
  `@@toPrimitive` field on the struct, dispatch via `call_ref`
  through the closure table (`__call_fn_1` analog as a private
  Wasm helper, not an export). Falls back to `valueOf`/`toString`
  in the same way. No JS recursion needed.
- **`__to_boolean`** → switch on struct type via `ref.test`:
  `undefined`/`null` → 0; number boxes → `value != 0 && !NaN`;
  string → `len > 0`; else 1.
- **`__typeof`** → switch on `ref.test` chain returning interned
  string globals.

The compiler already emits the i31ref code path under `--fast`; the
work is unifying it so the externref boundary disappears entirely in
standalone mode.

## Acceptance criteria

- [ ] `--standalone` build emits zero `env::__box_*`,
      `env::__unbox_*`, `env::__to_primitive`, `env::__to_boolean`,
      `env::__typeof*` imports.
- [ ] `wasmtime run` succeeds for: `let x: any = 1 + 2;`, `let s =
      typeof x;`, `if (x) ...`, `String({})`, `Number("3.14")`,
      `Boolean(NaN)`, dynamic property access that returns a number.
- [ ] `tests/equivalence.test.ts` green under both `--js-host` (default)
      and `--standalone` for all currently-passing `any`/`number`/
      `boolean`/`typeof` examples.
- [ ] Standalone-mode `Symbol()` produces distinct refs; `Symbol() ===
      Symbol()` returns false; well-known `Symbol.iterator` is shared
      across modules in the same instance.
- [ ] Bench: standalone `__unbox_number` Wasm path within 1.5× of the
      JS-host fast path on a hot numeric loop (no regression on
      `playground-benchmark`).

## Files to modify

- `src/codegen/index.ts` lines 4870–4924 — gate the `addImport` calls
  on a new `ctx.standalone` flag; emit equivalent Wasm helpers
  instead.
- `src/codegen/type-coercion.ts` lines 136–148, 199–360, 1296–1410 —
  replace `ensureLateImport("__unbox_number", …)` / `__box_number`
  with calls to new in-module helpers (`$__wasm_unbox`,
  `$__wasm_box_num`).
- `src/codegen/binary-ops.ts` (numerous `__unbox_number` sites:
  241, 869, 892, 1404, 1627, 1683, 1715, 1736) — same retargeting.
- `src/codegen/object-ops.ts` lines 167–168, 2289–2352 — i31-aware
  box/unbox for property values.
- `src/codegen/typeof-delete.ts` lines 241, 782 — switch from
  `__box_number` to the i31 path; `typeof` dispatch via Wasm
  `ref.test` chain instead of host imports.
- `src/runtime.ts` lines 2463–2509, 4551–4581 — leave host-mode
  fast path intact; standalone path bypasses these entirely.
- New file: `src/codegen/wasm-helpers/box-unbox.ts` — emit the
  in-module `$__wasm_box_num`, `$__wasm_unbox`, `$__wasm_to_bool`,
  `$__wasm_typeof_str` helpers on first use.

## Implementation Plan

### Root cause
Every `ensureLateImport("__box_number", …)` and `ensureLateImport(
"__unbox_number", …)` site (35+ call sites across `array-methods.ts`,
`closures.ts`, `expressions/calls.ts`, `expressions/calls-closures.ts`,
`expressions/new-super.ts`, `expressions/identifiers.ts`,
`property-access.ts`, `object-ops.ts`, `function-body.ts`,
`typeof-delete.ts`, `binary-ops.ts`, `type-coercion.ts`) emits a host
import even when the target is `wasi`/`standalone`. WasmGC + i31ref
already provide every primitive boxer/unboxer in pure Wasm; the work
is centralizing the dispatch and routing every call site through
a single helper that decides JS-host vs Wasm-native.

### Prerequisite (depends on #1470)
This issue inherits the `ctx.standalone` flag + `noJsHost = ctx.wasi
|| ctx.standalone` convention from #1470. The CLI plumbing in #1470
must land first.

### New helper module: `src/codegen/wasm-helpers/box-unbox.ts`

This file owns the in-module Wasm helpers. All helpers are idempotent
and cached on `ctx` (mirrors the `ctx.nativeStrHelpers` pattern).

**Types to register on first use** (add to `ctx.boxHelpers` map):

```
(type $BoxedNumber  (struct (field $value f64)))
(type $BoxedBoolean (struct (field $value i32)))   ;; optional — see below
(type $Symbol       (struct (field $desc (ref null $AnyString))
                            (field $id   i32)))     ;; fresh each alloc
```

Register them by adding `ctx.boxedNumberStructTypeIdx`,
`ctx.symbolStructTypeIdx` fields (mirror `ctx.errorStructTypeIdx`).
For `Boolean`, use two module-level globals `$__true` and
`$__false` (singletons) of type `(ref null $BoxedBoolean)`, OR
just use i31ref `(i31.new (i32.const 1))`/`(i31.new (i32.const 0))`
with a dedicated tag bit. The tag bit is cheaper (no allocation).

**Helper functions** (all internal; never exported; never imported):

```
$__box_num_wasm    (f64) -> anyref
$__unbox_num_wasm  (anyref) -> f64
$__box_bool_wasm   (i32)  -> anyref
$__to_bool_wasm    (anyref) -> i32
$__typeof_wasm     (anyref) -> ref $AnyString
$__to_uint32_wasm  (anyref) -> i32
$__to_primitive_wasm (anyref, i32 hint) -> anyref
$__box_symbol_wasm (i32 id) -> ref $Symbol
```

#### `$__box_num_wasm`

```wat
(func $__box_num_wasm (param $v f64) (result anyref)
  ;; SMI fast path: if v is an integer in [-2^30, 2^30), use i31ref
  local.get $v
  local.get $v
  f64.trunc
  f64.eq                       ;; is integer?
  (if (result anyref)
    (then
      local.get $v
      i32.trunc_sat_f64_s
      local.tee $i
      i32.const 0x40000000
      i32.lt_s
      local.get $i
      i32.const -0x40000000
      i32.ge_s
      i32.and
      (if (result anyref)
        (then local.get $i ref.i31)
        (else local.get $v struct.new $BoxedNumber)))
    (else
      local.get $v
      struct.new $BoxedNumber)))
```

The i31 fast path matters: hot numeric loops on `let x: any = i;
y += x;` would otherwise allocate per iteration. Once #1471
lands, the playground `fib` / `mandelbrot` examples should
benchmark within ~1.3× of the JS-host fast path (per the
acceptance criteria 1.5× ceiling).

#### `$__unbox_num_wasm`

```wat
(func $__unbox_num_wasm (param $v anyref) (result f64)
  block $done (result f64)
    ;; i31 fast path
    local.get $v
    ref.test (ref i31)
    if
      local.get $v
      ref.cast (ref i31)
      i31.get_s
      f64.convert_i32_s
      br $done
    end
    ;; $BoxedNumber
    local.get $v
    ref.test (ref $BoxedNumber)
    if
      local.get $v
      ref.cast (ref $BoxedNumber)
      struct.get $BoxedNumber $value
      br $done
    end
    ;; $FlatString — parse as number (existing $__parse_number helper
    ;; from native-strings.ts; emit if not present)
    local.get $v
    ref.test (ref $AnyString)
    if
      local.get $v
      ref.cast (ref $AnyString)
      call $__str_to_number    ;; returns f64 or NaN
      br $done
    end
    ;; null → 0, undefined → NaN, $Object → call @@toPrimitive
    ;; (Phase 1: dispatch to $__to_primitive_wasm hint=number then
    ;; recurse; the recursion terminates because $__to_primitive_wasm
    ;; only returns refs that hit the type-tests above)
    local.get $v
    ref.is_null
    if
      f64.const 0
      br $done
    end
    local.get $v
    i32.const 0   ;; hint = number
    call $__to_primitive_wasm
    call $__unbox_num_wasm     ;; tail call — see below
  end)
```

Use `return_call $__unbox_num_wasm` for the tail recursion to avoid
stack growth on adversarial inputs.

#### `$__to_bool_wasm` (ECMA-262 §7.1.2)

```wat
(func $__to_bool_wasm (param $v anyref) (result i32)
  local.get $v ref.is_null  if i32.const 0 return end
  ;; i31: 0 → false, else true
  local.get $v ref.test (ref i31)
  if
    local.get $v ref.cast (ref i31) i31.get_s
    i32.const 0
    i32.ne
    return
  end
  ;; $BoxedNumber: value != 0 && !NaN
  local.get $v ref.test (ref $BoxedNumber)
  if
    local.get $v ref.cast (ref $BoxedNumber)
    struct.get $BoxedNumber $value
    local.tee $f
    f64.const 0
    f64.ne
    local.get $f
    local.get $f
    f64.eq        ;; NaN check (NaN != NaN)
    i32.and
    return
  end
  ;; $AnyString: len > 0
  local.get $v ref.test (ref $AnyString)
  if
    local.get $v ref.cast (ref $AnyString)
    call $__str_length
    i32.const 0
    i32.ne
    return
  end
  ;; any other ref (object, function, symbol) → true
  i32.const 1)
```

#### `$__typeof_wasm`

Returns a singleton `ref $FlatString` for one of `"undefined"`,
`"object"` (null), `"boolean"`, `"number"`, `"string"`,
`"function"`, `"symbol"`, `"object"` (any other). The 8 result
strings are added to the string pool by
`ensureBoxUnboxHelpers(ctx)` and looked up as globals.

```wat
(func $__typeof_wasm (param $v anyref) (result (ref $AnyString))
  local.get $v ref.is_null
  if global.get $__str_undefined return end
  local.get $v ref.test (ref i31)
  if global.get $__str_number return end
  local.get $v ref.test (ref $BoxedNumber)
  if global.get $__str_number return end
  local.get $v ref.test (ref $AnyString)
  if global.get $__str_string return end
  local.get $v ref.test (ref $Symbol)
  if global.get $__str_symbol return end
  ;; Function detection: walk vtable for $functionTag — Phase 2.
  ;; Phase 1: treat all $Closure subtypes as "function" via ref.test
  ;; against the registered closure struct.
  local.get $v ref.test (ref $Closure_base)
  if global.get $__str_function return end
  global.get $__str_object)
```

#### `$__to_uint32_wasm`

Pure-Wasm ECMA-262 §7.1.7: `unbox_num → f64 → i32.trunc_sat_f64_s
→ i32 (masked to uint32 semantics by Wasm's natural wrap)`. One
internal call to `$__unbox_num_wasm`; no host import.

#### `$__to_primitive_wasm` (ECMA-262 §7.1.1)

Phase 1 stub: for any object ref, walk a vtable-resolved `toString`
/`valueOf` based on hint. For Phase 1, return:

- For primitives (i31, $BoxedNumber, $AnyString, ref.null) →
  pass-through
- For `$Object` with a registered `@@toPrimitive` method → call
  via `call_ref` (object-ops.ts vtable infrastructure provides
  this once #1472 lands)
- For other refs → call `$__any_to_string` (from #1470) when
  hint=string, else look up `valueOf` else return as-is.

Full §7.1.1 conformance can land as a follow-up; Phase 1 only
needs the common cases: `Number("3")`, `String({})`,
`+x where x is a number-box`.

#### `$__box_symbol_wasm`

```wat
(func $__box_symbol_wasm (param $id i32) (result (ref $Symbol))
  global.get $__str_undefined        ;; desc placeholder; user Symbols
                                      ;; get the user-provided desc via
                                      ;; a 2-arg overload (Phase 2)
  local.get $id
  struct.new $Symbol)
```

For well-known symbols (`Symbol.iterator`, `Symbol.asyncIterator`,
…), emit a one-time `start` initializer that fills module-level
`(global $__sym_iterator (mut (ref null $Symbol)))` slots from
`__box_symbol_wasm(<intrinsic-id>)`. Existing #1325
`BUILTIN_TYPE_TAGS` provides the ID registry.

### Routing at every call site

Introduce a single function in
`src/codegen/wasm-helpers/box-unbox.ts`:

```ts
/**
 * Emit a call that boxes f64 → anyref. In JS-host mode, uses the
 * `__box_number` host import (existing behavior). In standalone /
 * WASI mode, emits a call to the in-module `$__box_num_wasm` helper.
 * Returns the resulting Wasm value type so callers can plumb it
 * through coerceType.
 */
export function emitBoxNumber(
  ctx: CodegenContext, fctx: FunctionContext
): ValType {
  const noJsHost = ctx.wasi || ctx.standalone;
  if (noJsHost) {
    const idx = ensureBoxUnboxHelper(ctx, "__box_num_wasm");
    fctx.body.push({ op: "call", funcIdx: idx });
    return { kind: "anyref" };  // NOT externref — host-mode contract
                                 // returned externref; standalone returns
                                 // anyref. Callers must coerce when
                                 // crossing into externref contexts.
  }
  // JS-host fast path
  const idx = ensureLateImport(ctx, "__box_number",
    [{ kind: "f64" }], [{ kind: "externref" }]);
  fctx.body.push({ op: "call", funcIdx: idx });
  return { kind: "externref" };
}

export function emitUnboxNumber(
  ctx: CodegenContext, fctx: FunctionContext
): void {
  // Same shape; result is f64 in both modes.
  const noJsHost = ctx.wasi || ctx.standalone;
  if (noJsHost) {
    const idx = ensureBoxUnboxHelper(ctx, "__unbox_num_wasm");
    fctx.body.push({ op: "call", funcIdx: idx });
    return;
  }
  const idx = ensureLateImport(ctx, "__unbox_number",
    [{ kind: "externref" }], [{ kind: "f64" }]);
  fctx.body.push({ op: "call", funcIdx: idx });
}
```

Equivalent helpers: `emitBoxBoolean`, `emitUnboxBoolean`,
`emitToBoolean`, `emitToUint32`, `emitTypeofResult`, `emitToPrimitive`.

Then **every existing call site** that does
`ensureLateImport(ctx, "__box_number"|"__unbox_number"|"__to_boolean"|
"__to_primitive"|"__typeof"|"__to_uint32"|"__box_boolean"|
"__unbox_boolean", …)` followed by `fctx.body.push({ op: "call",
funcIdx })` is rewritten to call the new `emitBox*` / `emitUnbox*`
helpers. Use `rg` to enumerate:

```
rg "ensureLateImport.*(__box_number|__unbox_number|__to_boolean|__to_primitive|__typeof|__to_uint32|__box_boolean|__unbox_boolean)" src/codegen/
```

Sites confirmed from the existing grep (#1471 issue body line 130
references many; full list ≈ 35 sites):

| File                                       | Lines (approx)                           |
| ------------------------------------------ | ---------------------------------------- |
| `src/codegen/array-methods.ts`             | 864, 968, 1072                           |
| `src/codegen/closures.ts`                  | 1963, 2060                               |
| `src/codegen/expressions/calls.ts`         | 738, 2621, 2626, 2669, 2676, 2683, 6342, 6649, 6653 |
| `src/codegen/expressions/calls-closures.ts`| 299, 312                                 |
| `src/codegen/expressions/new-super.ts`     | 1066, 1083                               |
| `src/codegen/expressions/identifiers.ts`   | (TDZ throws — covered by #1473)          |
| `src/codegen/function-body.ts`             | 802, 803                                 |
| `src/codegen/property-access.ts`           | 650, 656, 1090, 1098, 2093, 2200, 2208, 2320, 2390, 2501 |
| `src/codegen/object-ops.ts`                | 167, 168, 2289–2295, 2346–2354           |
| `src/codegen/binary-ops.ts`                | 241, 869, 892, 1404, 1627, 1683, 1715, 1736 |
| `src/codegen/type-coercion.ts`             | 136–148, 199–360, 1296–1410              |
| `src/codegen/typeof-delete.ts`             | 241, 782 (typeof dispatch)               |

**Strategy**: do not change the call-site files one at a time.
Instead, search-and-replace mechanically across the codebase:
replace the `ensureLateImport(ctx, "__box_number", [{kind:"f64"}],
[{kind:"externref"}])` followed by `fctx.body.push({op:"call",
funcIdx})` pattern with `emitBoxNumber(ctx, fctx)`. Same for unbox.
This is a ~500-line diff but mostly mechanical.

### ABI contract: externref vs anyref

In JS-host mode the existing code expects `__box_number(f64) ->
externref` because the resulting value flows into JS interop
contexts (host imports, JS-side `Reflect.get`, etc.). In
standalone mode there is no JS, so anyref is the natural type —
externref still works but adds spurious `extern.convert_any` round-
trips. **Decision**: keep externref as the canonical "anything"
type in both modes for ABI stability. Standalone helpers emit
`extern.convert_any` at the end to return externref:

```wat
(func $__box_num_wasm (param $v f64) (result externref)
  ;; ... build anyref result on stack ...
  extern.convert_any)
```

This costs one instruction per call but avoids touching the call
sites' type expectations. Same for the other helpers.

### Late-import shift interaction

`ensureBoxUnboxHelper` does NOT call `addImport` — it appends to
`ctx.mod.functions` and assigns a `funcIdx` of
`ctx.numImportFuncs + ctx.mod.functions.length` (the same pattern
`emitWasiErrorConstructor` uses, see
`src/codegen/registry/error-types.ts:116`). No
`shiftLateImportIndices` needed because no new import is added —
the helper's funcIdx is past all existing imports and stable.

If a helper itself calls another helper (e.g., `$__unbox_num_wasm`
calling `$__to_primitive_wasm`), emit them in dependency order and
record the funcIdx before emission so forward references work
(mirror the technique in `native-strings.ts`).

### Test approach

- **Existing**: `tests/equivalence.test.ts` covers `let x: any =
  …`, typeof, boxing into objects, dynamic property assignment.
  All must remain green in default mode and pass under `--target
  standalone`.
- **New**: `tests/standalone-boxing.test.ts`:
  - Hot numeric loop with `any`-typed accumulator (benchmarks i31
    fast path)
  - `typeof x === "string"`, `typeof x === "function"`,
    `typeof x === "symbol"`
  - `Number("3.14")`, `Number(true)`, `Number(null)`
  - `Boolean(NaN)`, `Boolean("")`, `Boolean(0)`, `Boolean({})`
  - `let s = Symbol(); let t = Symbol(); s === t` (false)
  - Well-known symbol identity:
    `Symbol.iterator === Symbol.iterator` (true)
- **Import-section assertion**: reuse the
  `assert-no-js-host-imports.ts` helper from #1470 — must report
  zero `env::__box_*`, `env::__unbox_*`, `env::__to_*`,
  `env::__typeof*`, `env::__box_symbol`.
- **Bench**: add a standalone variant to
  `benchmarks/playground/` for one hot numeric loop; gate
  acceptance on `1.5×` JS-host fast path ceiling.

### Dependency ordering

Within #1471 itself:

1. Land `$BoxedNumber` struct + `$__box_num_wasm` / `$__unbox_num_wasm`
   first — unblocks ~80% of call sites (numeric box/unbox is the
   most common).
2. `$__to_bool_wasm` + `$__typeof_wasm` next — covers the rest
   of the if/typeof surface.
3. `$__box_symbol_wasm` and `$__to_primitive_wasm` last —
   `$__to_primitive_wasm` Phase-1 stub is enough to land all
   tests that don't use user-defined `@@toPrimitive`.

Cross-issue ordering:

- #1470 lands first (provides `ctx.standalone` flag, native
  string types).
- #1471 lands second (this issue).
- #1473 depends on #1471 for the typed-throw path
  (`$__throw_type_err` constructs a `$TypeError` whose
  `$message` field is anyref — needs the boxing infra).
- #1472 depends on #1471 for property values
  (anyref slots, vtable-driven dispatch). #1472 also needs
  `$__to_primitive_wasm` to land fully.
- #1474 is independent (Phase 1 is just a compile-time error).
