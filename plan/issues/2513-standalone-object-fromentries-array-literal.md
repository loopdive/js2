---
id: 2513
title: "standalone: Object.fromEntries([[\"k\",\"v\"],…]) over a string-key array literal (#2042 S3 residual)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: objects, Object.fromEntries
goal: standalone-mode
related: [2042, 2190, 1472]
origin: "TaskList #85 (#2042 S3 residual)"
---

# #2513 — standalone Object.fromEntries over a string-key array literal

## Problem (current main, `--target standalone`)

```ts
const o: any = Object.fromEntries([["a", 1], ["b", 2]]);
o.a;   // refused: "Codegen error: '__object_fromEntries' … not supported"
```

`Object.fromEntries` of an array literal of pairs was a #1472-Phase-B refusal
standalone. A native `__object_fromEntries` helper that iterates the entries via
`__extern_get_idx` only works when the entries arg is a `$ObjVec` (e.g.
`Object.fromEntries(Object.entries(o))`); a native array LITERAL is a typed vec,
not a `$ObjVec`, and indexing it through the externref boundary mis-casts.

## Fix

Mirror `compileObjectAssignArg` (the array→`$Object` normalisation Object.assign
uses): at the `Object.fromEntries` call site (`src/codegen/expressions/calls.ts`),
when the entries arg is an **array literal of two-element pairs with STRING keys**,
NORMALISE it into a `$ObjVec` of pair `$ObjVec`s
(`__objvec_new`/`__objvec_push`), then hand the native `__object_fromEntries`
helper that indexable shape. The helper builds the `$Object` via `__extern_set`
(which ToPropertyKeys each key).

Key scoping:
- `__object_fromEntries` is registered in `ensureObjectRuntime` but **NOT** added
  to `OBJECT_RUNTIME_HELPER_NAMES` — so the ordinary path (raw arg / Map /
  non-string-key) keeps REFUSING (compile error) rather than routing native and
  trapping on the non-`$ObjVec` representation. The call site resolves the helper
  from `funcMap` only on the safe array-literal-of-string-key-pairs shape.
- NUMERIC-key literals (`[[1,"a"]]`) and Maps keep the pre-existing refusal — a
  numeric key round-trips through `__objvec_push`/`__extern_get_idx` and
  mis-casts in `__to_property_key`; gating to string keys avoids introducing a
  new trap there. (Numeric-key + Map/iterator are a #2190/iterator follow-up.)

## Acceptance criteria

1. `Object.fromEntries([["a",1],["b",2]])` builds the object standalone (no leak,
   correct values, key count, last-wins, string/bool/mixed values).
2. No regression: `Object.fromEntries(Object.entries(o))` ($ObjVec entries)
   unchanged; the raw/Map/numeric-key shapes keep their compile-error refusal
   (NOT a new trap).

## Resolution (sdev-arrayrep, 2026-06-19)

Call-site `$ObjVec` normalisation + funcMap-resolved native helper per above.
MEASURED: `[["a",1]]`→1, multi-pair→2, key-count→3, last-wins→9, string-val→1,
bool-val→1, mixed→6; `Object.entries` control→7; numeric-key literal still
refuses (compile error, not a trap). wasm-opt `-O3` passes.
`tests/issue-2042-fromentries-objvec.test.ts` (8) green; #2042 S1/S3 + object-keys
suites unchanged (the one pre-existing `non-integer numeric key` failure is broken
on main without this change). `tsc` + coercion gate clean.

Depends on #2511 (any[]-of-tuple nested access) for the in-branch base, though the
call-site conversion sidesteps the helper's raw-vec indexing entirely.
