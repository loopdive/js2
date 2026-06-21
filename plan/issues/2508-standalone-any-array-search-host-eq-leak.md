---
id: 2508
title: "standalone: any[].indexOf/includes/lastIndexOf leak env.__host_eq/__same_value_zero (no native impl)"
status: in-progress
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, array-methods, equality
goal: standalone-mode
related: [1776, 1917, 2505, 2506, 2507, 54]
origin: "2026-06-19 sdev-arrayrep: array-rep scan tail — TaskList #72"
---

# #2508 — standalone `any[]` search methods leak `__host_eq`/`__same_value_zero`

## Problem (file-verified, current main, `--target standalone`)

`any[].indexOf(x)` / `lastIndexOf(x)` leak an unsatisfiable `env.__host_eq`
import; `any[].includes(x)` leaks `env.__same_value_zero`. The module compiles
to VALID Wasm but cannot instantiate standalone (no JS host to satisfy the
import). `number[]`/`string[]` search methods do NOT leak (typed f64/i32/ref
compares).

```ts
const a: any[] = [1, 2, 3];
a.indexOf(2); // leaks env.__host_eq
a.includes(2); // leaks env.__same_value_zero
```

(`flat`/`flatMap` separately leak `__array_flat`/`__array_flatMap`/`__make_callback`
— tracked as a follow-up, different helper family.)

## Root cause

`compileArrayIndexOf` (`src/codegen/array-methods.ts` ~3697) and the array-like
search path (~1536) emit `ensureLateImport("__host_eq" | "__same_value_zero", ...)`
for an `externref` element. These names have NO native standalone
implementation, so `ensureLateImport` adds an `env::*` host import that can't be
satisfied without a JS runtime.

## Fix direction

The standalone strict-equality logic ALREADY EXISTS inline: binary-ops.ts ~2001
(#1776) emits a Wasm-native tag-dispatched `===` over two boxed externrefs
(typeof number → unbox f64 compare; typeof boolean → unbox i32; typeof bigint →
i64; else ref identity), needing no host import. The `===` operator over two
`any` values is already leak-free standalone (verified: `a[i] === a[j]` → env=[]).

Plan: provide native standalone implementations of `__host_eq` (Strict Equality,
§7.2.16 — NaN ≠ NaN) and `__same_value_zero` (SameValueZero, §7.2.11 — NaN =
NaN, +0 = -0) as registered helper functions built from the same
`__typeof_*`/`__unbox_*` building blocks #1776 uses, then route the
`ensureLateImport("__host_eq"/"__same_value_zero")` names to them under
`ctx.standalone`/`ctx.wasi` (mirroring the #1471 `UNION_NATIVE_HELPER_NAMES`
native-routing in expressions/late-imports.ts). Strict and SameValueZero differ
only in the NaN-self arm and ±0 handling.

## Acceptance criteria

1. `any[].indexOf(x)` / `lastIndexOf(x)` / `includes(x)` instantiate standalone
   with NO leaked `env.__host_eq`/`__same_value_zero` import.
2. Correct results: indexOf finds by Strict Equality (NaN not found; `[false].indexOf(0)`
   → -1 cross-type); includes finds by SameValueZero (`[NaN].includes(NaN)` → true).
3. No regression: number[]/string[] search unchanged; the `===` operator path
   (#1776) untouched; host (GC) mode still uses the host imports.

## Resolution (sdev-arrayrep, 2026-06-19)

Implemented native `__host_eq` / `__same_value_zero` in
`addUnionImportsAsNativeFuncs` (`src/codegen/index.ts`), each a tag-dispatched
equality over two boxed externrefs: both number → `__unbox_number` + `f64.eq`
(SameValueZero adds a `(a!=a && b!=b)` NaN-self recovery); both boolean →
`__unbox_boolean` + `i32.eq`; both bigint → `__to_bigint` + `i64.eq`; both
`$AnyString` → `__str_flatten` + `__str_equals` (string VALUE equality, not
identity); else WasmGC `eq`-heap reference identity; both-null → equal. Names
added to `UNION_NATIVE_HELPER_NAMES` (expressions/late-imports.ts) so the
existing `ensureLateImport("__host_eq"/"__same_value_zero")` call sites resolve
to the natives under `ctx.standalone`/`ctx.wasi`. Host (GC) mode is gated out
(addUnionImportsAsNativeFuncs only runs for wasi/standalone) and keeps the host
imports.

MEASURED (standalone, instantiate with `{}`): indexOf 2→1, 9→-1, NaN→-1 (strict),
[false].indexOf(0)→-1 (cross-type), boolean→found, fromIndex honored; includes
NaN→true (SVZ); lastIndexOf number. number[] search unchanged. #1776 (21) +
loose-equality + issue-2073 green; the #1776 leak assertion was tightened from a
`__host_eq` substring check to an `env`-IMPORT check (a native `(func $__host_eq
…)` is now legitimate). coercion-sites baseline refreshed (+2 index.ts, +1
late-imports.ts). wasm-opt `-O3` (native-messaging-smoke) passes.

**String-element search-by-VALUE — deferred follow-up (string arm of #2508).**
A boxed-any STRING element compares by content (`__str_flatten`+`__str_equals`).
Those helpers live in the native-string regime BELOW the union-helper base; a
call to them baked into the `__host_eq`/`__same_value_zero` union-helper body
drifts under the late-import finalize shift (`reconcileNativeStrFinalizeShift`
re-bases every `call funcIdx >= base`), landing on the wrong function — the
encoder then patches the stack with `extern.convert_any; …; drop`, which the GC
validator accepts but **wasm-opt rejects** ("popping from empty stack" — the
native-messaging-smoke CI failure on the first PR push). The string arm therefore
falls back to `eq`-heap **ref identity** here (valid Wasm; correct for interned/
same-ref strings). String-by-value belongs in a `__any_str_value_eq` helper
registered in the native-string regime, not the union-helper body — tracked as
the #2508 string-value follow-up.

**Out of scope (separate helper family, follow-up):** `any[].flat`/`flatMap`
leak `__array_flat`/`__array_flatMap`/`__make_callback` — need native flat/
flatMap + callback-dispatch impls, not equality. `typeof (true as any)` boxing a
boolean literal as a number (so `[true].indexOf(true as any)` via a literal
misses — works from an `any` var) is a separate pre-existing boxing quirk. Typed
`string[]` indexOf/includes by value is its own pre-existing standalone gap
(broken on main without this change).
