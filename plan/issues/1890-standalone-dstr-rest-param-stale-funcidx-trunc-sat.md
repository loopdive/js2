---
id: 1890
title: "standalone: dstr-rest-param fallback emits invalid Wasm (i32.trunc_sat_f64_s expected f64, found externref) — stale funcIdx after late-import shift (~1,142 fails)"
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring-params, late-imports
goal: standalone-mode
sprint: 59
related: [1839, 1602, 1592, 1219]
---
# #1890 — dstr-rest-param iterator-fallback uses a stale funcIdx → invalid Wasm

## Symptom

**~1,142 official standalone-lane compile failures** (largest non-owned bucket in
the 2026-06-05 standalone JSONL harvest):

```
invalid Wasm binary … i32.trunc_sat_f64_s[0] expected type f64, found call of
  type externref
```

All in array/object **destructuring-rest params** of class methods, generator /
async-generator methods, and for-await-of (samples below). WAT shows
`__dparam_*` locals.

## Sample failing tests

```
test/language/statements/class/dstr/async-private-gen-meth-static-ary-ptrn-rest-id.js
test/language/statements/class/dstr/gen-meth-static-dflt-ary-ptrn-rest-obj-id.js
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-empty.js
test/language/statements/for-await-of/async-func-dstr-var-ary-ptrn-rest-id-iter-close.js
```

Minimal repro (standalone): `function f([a, ...rest]: any): number { return a; }`
called with an `any`-typed array — the non-statically-typed-vec path takes the
iterator fallback. (Compounded by a sibling `__str_flatten` shift in the harness,
same root-cause class.)

## Root cause — stale funcIdx after a late-import index shift (#1839 class)

In `src/codegen/destructuring-params.ts`, the array-dstr iterator-fallback path:
1. captures `fbLenFn = ensureLateImport(ctx, "__extern_length", […] → f64)` (~:1012)
   and `fbGetIdxFn = ensureLateImport(ctx, "__extern_get_idx", …)` (~:1014);
2. THEN registers `fbIterFn = ensureLateImport(ctx, "__array_from_iter_n", …)` (~:1029).

`__array_from_iter_n` has **no** native standalone impl and is **not** in
`OBJECT_RUNTIME_HELPER_NAMES`, so under `--target standalone` it is added as a NEW
`env::` import. That addition **shifts function indices** — but `fbLenFn` /
`fbGetIdxFn` were already captured as plain integers, so they go stale.
`flushLateImportShifts` rewrites `fctx.body`, but not these escaped local
integers. At ~:1140 the emitted `call fbLenFn` now targets the wrong function
(an externref-returning one), so `i32.trunc_sat_f64_s` receives externref → the
module fails to instantiate. Same defect class as #1839 (re-resolve funcIdx after
`addUnionImports` shift) and #1602.

## Fix

Re-resolve `fbLenFn` / `fbGetIdxFn` (and any other captured fallback funcIdx) from
`ctx.funcMap` **after** all the fallback late-imports are registered and flushed
(or register `__array_from_iter_n` BEFORE capturing the length/get-idx indices so
no later shift invalidates them). Pure dev-lane destructuring-param codegen — does
NOT touch object-runtime.ts / the #1472 family.

## Acceptance

- The sample dstr-rest-param tests compile to a valid standalone module.
- No regression in the existing dstr / dstr-param suites.
- A standalone unit test covering an array-rest-dstr param over an `any`/iterable
  value that previously emitted the invalid `trunc_sat`.
