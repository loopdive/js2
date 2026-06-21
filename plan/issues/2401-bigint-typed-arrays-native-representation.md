---
id: 2401
title: "Wasm-native BigInt64Array / BigUint64Array — i64/BigInt element representation"
status: ready
created: 2026-06-19
updated: 2026-06-19
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: typed-arrays
goal: standalone-mode
sprint: Backlog
related: [2379, 2159]
---
# #2401 — Wasm-native `BigInt64Array` / `BigUint64Array`

## Problem

`BigInt64Array` and `BigUint64Array` are the only typed arrays js2wasm does
**not** model natively. They are absent from both `BUILTIN_TYPES`
(`src/checker/type-mapper.ts`) and `TYPED_ARRAY_NAMES` /
`typedArrayVecStorage` (`src/codegen/index.ts`), so `isExternalDeclaredClass`
claims them and their methods/ctor route to host extern-class imports:
standalone/WASI leaks `BigInt64Array_new` / `BigUint64Array_new` /
`BigUint64Array_get_length` (unsatisfiable → instantiation failure), and GC mode
hits the externref-vs-GC-ref receiver mismatch.

Found during the #2379 `BUILTIN_TYPES` sweep. **This is NOT the #2379 one-line
class**: the other typed arrays already had a native `(ref null $Vec[f64])`
representation to fall through to once added to `BUILTIN_TYPES`. BigInt64 arrays
carry **i64 / BigInt elements**, which need a distinct element representation
(an i64-element vec, BigInt boxing/unboxing at the marshalling boundary,
`BYTES_PER_ELEMENT = 8`, ToBigInt coercion on store). Adding them to
`BUILTIN_TYPES` alone would not give them a working native path — they'd just
fail differently.

## Scope (medium)

Add an i64-element vec representation for `BigInt64Array`/`BigUint64Array`:
register them in `TYPED_ARRAY_NAMES` + `typedArrayVecStorage` (i64 storage),
thread the element ValType through the ctor / index access / `.length` /
array-method paths, handle the BigInt↔i64 boundary (relies on the BigInt-i64
brand work, cf. #1349/#1644), then add to `BUILTIN_TYPES` so dispatch routes
natively. Pairs with the #2159 packed-integer-storage family (both rework the
typed-array element representation).

## Acceptance criteria

- `new BigInt64Array([1n,2n,3n])[1] === 2n`; `.length === 3`.
- Standalone: no `env.BigInt64Array_*` / `env.BigUint64Array_*` leaks.
- `BigUint64Array` unsigned semantics on read.

## Source

#2379 sweep, sd3, 2026-06-19.
