---
id: 3531
title: "standalone: retire __array_concat_any / __js_array_new / __js_array_push host-import leak (216 tests)"
status: ready
sprint: current
created: 2026-07-21
updated: 2026-07-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, arrays
language_feature: array-methods, typed-arrays
goal: standalone-mode
related: [1359, 1461, 1969, 2860]
test262_bucket: standalone-array-concat-host-import-leak
test262_count: 216
---

# #3531 — retire standalone array-concat host-import leakage

## Problem

The Sprint 74 close harvest found **216 official standalone Test262 rows** that
still emit the JS-host `__array_concat_any` bridge together with
`__js_array_new` and `__js_array_push`. A standalone build rejects those host
imports before the test can execute.

This is not the already-fixed #1969 host-bridge spreading bug: the failing
programs must avoid the host bridge entirely and lower the array construction
and concat operation through standalone-native representations.

## Evidence

- Fresh source: published `test262-standalone-current.jsonl`, fetched after the
  Sprint 74 final code landing.
- **201 rows** share the exact three-import signature
  `__array_concat_any` + `__js_array_new` + `__js_array_push`.
- **15 rows** have the concat leak plus additional imports and should be
  reclassified after the dominant shape is fixed.
- Dominant families: `Array/prototype` (**102**) and
  `TypedArray/prototype` (**90**).
- Representative files:
  - `test/built-ins/Array/prototype/concat_sloppy-arguments-with-dupes.js`
  - `test/built-ins/TypedArray/prototype/copyWithin/resizable-buffer.js`

All other fresh clusters above the 50-row harvest threshold already map to
active Markdown issues: #3395 owns the funcref/externref invalid-Wasm family,
#2161 owns the RegExp `buildString` property-escape family, and #1354 owns the
SharedArrayBuffer/Atomics family.

## Investigation anchors

- Trace why the affected standalone array/typed-array expressions select
  `compileArrayConcatExtern` or materialize a JS array instead of the native
  concat/vector path.
- Split the 201 exact-signature rows by receiver and argument representation;
  do not assume the Array and TypedArray families share one semantic cause.
- Reproduce through the standalone Test262 wrapper before changing code. The
  historical root-cause report is not authoritative; the JSONL signatures are.
- Preserve concat species, holes, arguments-object behavior, and resizable
  TypedArray semantics tracked by #1359 and #1461.

## Acceptance criteria

- A focused `tests/issue-3531.test.ts` covers representative Array and
  TypedArray cases in standalone mode.
- Targeted modules import none of `__array_concat_any`, `__js_array_new`, or
  `__js_array_push` and produce the same observable result as JavaScript.
- The 201-row exact-signature cluster is eliminated or narrowed with every
  remaining row assigned to a concrete Markdown owner.
- The 15 mixed-import rows are remeasured after the dominant fix and either
  pass or are explicitly classified.
- Host-mode equivalence and the standalone Test262 floor do not regress.
