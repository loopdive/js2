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
