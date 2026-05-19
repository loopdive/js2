---
id: 1471
sprint: 52
title: "host-independence: eliminate JS host boxing/unboxing for standalone Wasm"
status: ready
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
