---
id: 1552
sprint: backlog
title: "Tagged-union value representation: retire __box_*, __unbox_*, __typeof, __is_truthy"
status: backlog
created: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: refactor
area: runtime
language_feature: values
goal: standalone-wasm
related: [1535, 1471]
---

# #1552 — Uniform tagged-union value representation

## Problem
~12 host imports — `__box_number`, `__box_boolean`, `__box_symbol`, `__unbox_number`, `__unbox_boolean`, `__unbox_string`, `__is_truthy`, `__to_boolean`, `__to_primitive`, `__get_undefined`, `__extern_is_undefined`, `__typeof` (with `__typeof_*` setup imports) — exist because js2wasm currently boxes primitives into JS externref to participate in union types. Every `let x: number | string` round-trips through a JS object on assignment, and `typeof x` is a JS call.

This is the single biggest source of host calls for ordinary, non-error JS programs.

## Proposed solution
Introduce a uniform WasmGC tagged-union value type:

```wat
(type $Value (struct
  (field $tag i32)        ;; 0=undefined 1=null 2=boolean 3=number 4=string 5=object 6=symbol 7=bigint
  (field $f64 f64)        ;; number, or 0/1 for boolean
  (field $ref (ref null any))  ;; string (native i16 array), object, symbol, bigint
))
```

All polymorphic locals/params use `(ref $Value)`. Codegen emits inline construction and inspection — no host call required.

## Library/approach
None — internal IR change.

## Binary size impact
Codegen-level — likely a small reduction once `__box_*` import shims are removed. Per-value cost is a small constant (one struct allocation per box site), comparable to the externref allocation today.

## Test262 impact (estimated)
- Indirect: enables Recommendation #1 (errors), #2 (numbers), #3 (JSON) to operate without bouncing through externref.
- Direct: a handful of `typeof` tests currently fall back to host.
- Most importantly: this is a *prerequisite* for true standalone mode. Without it, every union-typed variable touches JS.

## Implementation steps
1. Define `$Value` struct in `src/codegen/registry/types.ts`.
2. New helpers in `src/codegen/value-helpers.ts`:
   - `$value.from_number(f64) -> ref $Value`
   - `$value.from_bool(i32) -> ref $Value`
   - `$value.from_string(native_str) -> ref $Value`
   - `$value.is_truthy(ref $Value) -> i32`
   - `$value.typeof(ref $Value) -> native_str`
   - `$value.to_primitive(ref $Value, hint) -> ref $Value` (depends on #1525)
3. Migrate codegen sites in `src/codegen/type-coercion.ts` to call the new helpers instead of `__box_*`.
4. Update `typeof` lowering in `src/codegen/typeof-delete.ts`.
5. Migrate `addUnionImports` in `src/codegen/index.ts` to fall through to native helpers when `ctx.nativeStrings || ctx.wasi`.
6. Keep host imports as opt-out for compatibility with externref-flavoured embedders.

## Risk
- Large blast radius — touches every union-typed code path.
- Object/symbol/bigint cases must still hold a reference; the discriminator + `(ref null any)` design accommodates this.
- Likely best done after #1536/#1537 land so the rest of the runtime is also externref-free.

## Builds on
#1471 (already in flight for some box/unbox retirement).

## Implementation Plan

(Author: architect, 2026-05-21. Refines the existing "Implementation
steps" with concrete file/function targets, struct field layout
rationale, and a phased migration plan that keeps test262 green at
every step.)

### Entry point

`registerValueType(ctx)` in a new file `src/codegen/registry/value-type.ts`,
exported and invoked from `src/codegen/index.ts` alongside
`registerNativeStringTypes` (src/codegen/registry/types.ts:200).

### Data structure

```wat
(type $Value (struct
  (field $tag  i32)           ;; tag enum, see below
  (field $f64  f64)           ;; number; or 0/1 for boolean
  (field $ref  (ref null any))));; native string vec / object / symbol / bigint payload
```

Tag enum (mirror in `src/codegen/registry/value-type.ts` as
`ValueTag.*` and as wat constants):

```
0 = UNDEFINED
1 = NULL
2 = BOOLEAN
3 = NUMBER
4 = STRING
5 = OBJECT
6 = SYMBOL
7 = BIGINT
```

Rationale for the unboxed-payload split (vs. one any-ref):
- `f64` field avoids per-number allocation; matches existing fast
  path for `let x: number` locals.
- `ref null any` carries strings/objects/symbols/bigints without
  externref bouncing — strings are native-string `(ref $StringArr)`
  in `nativeStrings` mode, objects are wasmgc structs.
- Discriminator in `i32` because there will be `< 16` tags; leaves
  room for future flags (e.g. bit 4 = "frozen") in a packed field.

A small sentinel constant struct `$UNDEFINED_VALUE` (tag=0) and
`$NULL_VALUE` (tag=1) can be created once at module init in a global
to avoid re-allocating for every `undefined`/`null` literal.

### Numbered algorithm

1. **Phase A — types and helpers (no codegen change)**
   1. Add `src/codegen/registry/value-type.ts` exporting
      `registerValueType`, `getValueTypeIdx`, `getValueTagConst`.
   2. Add `src/codegen/value-helpers.ts` with inline emitters that
      take and return `(ref $Value)`:
      - `emitValueFromNumber(ctx)` — push f64; `struct.new $Value`
        with tag=NUMBER, f64=value, ref=null.
      - `emitValueFromBool(ctx)` — push i32; convert to f64 (0/1);
        struct.new tag=BOOLEAN.
      - `emitValueFromString(ctx)` — push `(ref $StringArr)`;
        struct.new tag=STRING, ref=arg, f64=0.
      - `emitValueUndefined(ctx)` / `emitValueNull(ctx)` — global.get
        the precomputed sentinel.
      - `emitValueIsTruthy(ctx)` — switch on tag; for NUMBER use
        `f64.ne 0 && !f64.is_nan`; for BOOLEAN i32 mask; for STRING
        length != 0; for OBJECT/SYMBOL/BIGINT always true.
      - `emitValueTypeof(ctx)` — switch on tag → native-string
        constant pool: "undefined" / "object" / "boolean" / "number"
        / "string" / "object" / "symbol" / "bigint" (note: NULL and
        OBJECT both yield "object").
      - `emitValueToPrimitive(ctx, hint)` — depends on #1525; for
        primitive tags returns self; for OBJECT/SYMBOL routes through
        a generated `$value_to_primitive` wasm function (no host
        call).

2. **Phase B — typeof + truthiness migration**
   1. In `src/codegen/typeof-delete.ts` replace the `__typeof` import
      call with `emitValueTypeof` when the operand is already a
      `(ref $Value)`. Keep the host path as fallback for legacy
      externref operands until Phase D.
   2. In binary-ops / control-flow `if`/`while`/`?:` truthiness
      coercion (search `__is_truthy` and `__to_boolean`), call
      `emitValueIsTruthy` when operand is `(ref $Value)`.

3. **Phase C — union-typed locals/params lowering**
   1. In `src/codegen/type-coercion.ts` (`coerceType`, line ~530-1900),
      every site that currently does `f64 → externref via __box_number`
      becomes `f64 → (ref $Value) via emitValueFromNumber`. Same for
      bool and string variants.
   2. The unboxing path (`__unbox_number`) becomes
      `struct.get $Value $f64` (with a `tag == NUMBER` guard that
      otherwise calls a slow `$value_to_number` path).
   3. Function signatures with union params change from `externref` to
      `(ref $Value)`; update `addUnionImports` callers in
      `src/codegen/index.ts` to choose the value-typed signature when
      `ctx.nativeStrings || ctx.wasi`.

4. **Phase D — retire host imports**
   1. Once Phase C is on for both JS-host and standalone modes, remove
      `__box_number`, `__box_boolean`, `__box_symbol`, `__unbox_*`,
      `__is_truthy`, `__to_boolean`, `__typeof`, `__get_undefined`,
      `__extern_is_undefined` from `src/codegen/registry/imports.ts`.
   2. Delete the JS shims from `src/runtime.ts`.
   3. Keep `__to_primitive` until #1525 lands a wasm-native version.

5. **Phase E — `addUnionImports` index-shift cleanup** (see project
   CLAUDE.md note). Since most union helpers vanish, the late-import
   shifter has many fewer cases; simplify or remove the shifter.

### Example wasm output — `let x: number | string = 42; typeof x`

Before (current):

```wat
f64.const 42
call $__box_number       ;; -> externref
local.set $x
local.get $x
call $__typeof           ;; -> externref ("number")
```

After:

```wat
f64.const 42
ref.null any
i32.const 3              ;; tag NUMBER
struct.new $Value        ;; (tag=3, f64=42, ref=null)
local.set $x
local.get $x
struct.get $Value $tag
;; switch table -> push native string "number"
```

### Edge cases

- **`undefined === undefined`** must remain true. The sentinel global
  pattern ensures pointer equality works for the common case; the
  generic equality path compares tags first.
- **`NaN`** — `tag=NUMBER, f64=NaN`; equality must still return false
  per IEEE 754.
- **`-0` vs `+0`** — `Object.is` uses tag + bit-pattern comparison;
  `===` uses f64 equality.
- **`null` vs `undefined`** — both have ref=null but distinct tags; do
  NOT collapse.
- **`typeof null === "object"`** — handled by tag→string table.
- **`Symbol("x")`** — tag=SYMBOL, ref points at sidecar symbol
  record; ensure existing symbol-keyed property lookup keeps working
  through the tagged form.
- **`BigInt`** — tag=BIGINT, ref points at bigint payload (today
  externref-backed; preserve as `(ref null any)` until #1535 lands a
  native bigint).
- **String → Number coercion (`Number("5")`)** — Phase C requires the
  slow path `$value_to_number` to call into the existing native-string
  parser, NOT bounce to JS.
- **Function references** — wasm-side function values get tag=OBJECT
  with the funcref smuggled through the `ref` field via
  `struct.new_funcref_wrapper` (existing pattern; see #1116b).
- **Identity through host boundary** — when a `(ref $Value)` is
  passed to a host import, externalize the payload (number→box,
  string→jsString) only at the boundary; the inner wasm stays
  unboxed. `_hostProxyReverse`-style cache keyed on the `$Value`
  reference preserves `===` identity round-trips.

### Test262 paths to watch

- `test/built-ins/Number/*` — direct unboxed-number behaviour
- `test/language/expressions/typeof/*` — tag-table correctness
- `test/language/expressions/equals/*`, `strict-equals/*` — `===` /
  `==` across tag boundaries
- `test/language/expressions/logical-and/*`, `logical-or/*`,
  `conditional/*` — truthiness paths
- `test/built-ins/JSON/stringify/*` — string/number/boolean
  serialization without host bouncing

Acceptance: after Phase D, `__box_number` / `__unbox_number` /
`__typeof` / `__is_truthy` / `__to_boolean` no longer appear in
emitted wasm of any test262 case (grep the JSONL dump). No net
regression on test262 pass count after Phase D.

### Dependencies

- **#1471** (in flight) — partial box/unbox retirement; coordinate to
  avoid file conflicts on `type-coercion.ts`.
- **#1525** — wasm-native ToPrimitive; needed for Phase A.6 but
  blocks only Phase A.6, not Phase B/C.
- **#1535** — native bigint; needed before BIGINT tag payload can be
  fully unboxed.
- **#1536 / #1537** — externref-free runtime; landing these first
  reduces conflict surface for Phase D.

### Risks

- **Huge blast radius**: every union-typed code path. Mitigation —
  ship Phase A as inert (helpers exist but unused), Phase B as
  optional behind `ctx.useTaggedUnion` flag, Phase C as default
  flag-on with a one-week soak in CI, Phase D as cleanup.
- **Binary size**: every `let x: number | string = 42` now allocates
  a 24-byte struct. Mitigation — peephole pass detects monomorphic
  uses and emits unboxed f64 directly; tagged form only when
  cross-type union flow is observed.
- **Performance**: tag dispatch on `typeof`/truthiness is an i32 load
  + branch, faster than the current host call but slower than the
  monomorphic unboxed path. Mitigation — same monomorphism check as
  above.
