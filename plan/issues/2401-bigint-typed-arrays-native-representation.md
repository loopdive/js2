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

## Progress — residual (a) native method-routing (2026-07-17, WIP branch `issue-2401-native-method-routing`, stacked on #838)

Adding `BigInt64Array` / `BigUint64Array` to `BUILTIN_TYPES`
(`src/checker/type-mapper.ts`) stops `isExternalDeclaredClass` claiming them, so
prototype methods route to the **native** typed-array array-method paths instead
of the unsatisfiable `env.<View>_<method>` host imports. This eliminates ALL the
standalone host-import leaks (verified: `subarray` / `at` / `fill` / `slice` /
`reverse` / `set` no longer leak).

**But it is NOT a clean, contained landing** — it exposes 6 methods whose native
codegen assumes an i32/f64 element and emits **invalid Wasm** on an i64 element:

| native method-routing status (standalone, i64 element) | methods |
|---|---|
| ✅ valid + correct | `subarray`*, `at`, `fill`, `slice`, `set`, `reverse`, `map`, `filter`, `forEach`, `find`, `findIndex`, `some`, `every`, `copyWithin`, `sort` |
| ❌ INVALID Wasm | `indexOf`, `includes`, `lastIndexOf` (element compare: `array-methods.ts:2483` `eqOp = f64?"f64.eq":"i32.eq"` has no `i64.eq` arm; the search value also needs i64 typing), `reduce` (accumulator i64 threading), `toString` / `join` (element→string needs BigInt ToString, not the f64/i32 path) |

`*` `subarray(...).length` direct-chain length is the separate #2649 bug (fixed
generically by #3285) — the subarray VIEW itself + its element reads are correct
for i64.

The callback methods (`map`/`filter`/`find`/…) already work because the callback
receives the element as a properly-branded `{i64,bigint}` value. The 6 broken
methods all touch element **comparison / stringification / accumulation** — the
exact "thread the element ValType through the array-method paths" work this issue
scoped as representation-scale. Fixing all 6 correctly (SameValueZero for
`includes`, ToString §7.1.19 for `join`/`toString`, i64 accumulator for `reduce`,
i64 search-value compilation for the compare trio) is a proper sized task, not a
one-PR routing tweak.

**Recommendation**: land `BUILTIN_TYPES` registration TOGETHER WITH the 6-method
i64 fixes as one coherent PR (so no method ever regresses to invalid Wasm), or
split the 6 fixes into their own sub-issue. The WIP branch has the
`BUILTIN_TYPES` change + this analysis; it is deliberately NOT PR'd because it
would make those 6 methods emit invalid modules.

## Source

#2379 sweep, sd3, 2026-06-19.
