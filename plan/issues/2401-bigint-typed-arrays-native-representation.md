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

## Re-scope after #838 (2026-07-17)

Most of this issue's core is **delivered by #838** (BigInt64Array / BigUint64Array
typed arrays — the i64-element vec representation): `typedArrayVecStorage` returns
i64 for both views (host/gc + standalone/WASI), `resolveWasmType` maps them to the
i64 vec, and the native count/copy constructors + index access + `.length` /
`.byteLength` / `BYTES_PER_ELEMENT` all work. So the first acceptance bullet is
already met:

- ✅ `new BigInt64Array([1n,2n,3n])[1] === 2n`; `.length === 3` — done by #838
  (verified in `tests/issue-838.test.ts`).

Residual scope, to be picked up as a **post-#838 follow-up** (do not stack on the
in-flight #838 branch — it touches the same core files):

- **(a) Native method-routing** — the two views are still NOT in
  `BUILTIN_TYPES` (`src/checker/type-mapper.ts`), so `isExternalDeclaredClass`
  still claims them and prototype-method dispatch routes to extern-class host
  imports. Standalone still leaks e.g. `env.BigUint64Array_subarray` (verified:
  `new BigUint64Array(4).subarray(1)` leaks the host import; `.length` / bare
  value use do NOT leak after #838). Fix = add both names to `BUILTIN_TYPES` and
  thread the i64 element ValType through the shared typed-array array-method
  paths (subarray / slice / at / set / …). A contained Opus follow-up.

- **(b) `BigUint64Array` unsigned semantics on read** — a **fundamental
  i64-representation limit**, NOT a routing bug. The compiler's BigInt IS a
  signed wasm i64, so a `BigUint64Array` element ≥ 2^63 reads back as its signed
  interpretation (2^64-1 → -1n). This is the *same* limit that makes
  `BigInt.asUintN(64, x)` return `x` unchanged (#3148, call-builtin-static.ts:
  bits≥64 returns the value as-is). Lifting it needs an unsigned-BigInt boxing
  path (a distinct wrapper at the i64→JS-bigint boundary) that spans the whole
  BigInt representation — deeper, likely its own issue in the architect lane, not
  a typed-array-local fix.

Leaving this issue **`ready`** for the (a) follow-up once #838 lands; (b) should
be split into its own representation-level issue.

## Source

#2379 sweep, sd3, 2026-06-19.
