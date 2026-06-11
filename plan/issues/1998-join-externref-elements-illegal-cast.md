---
id: 1998
title: "join() traps 'illegal cast' on externref-element arrays — any[] numbers, undefined/null elements, holes, Array(n) results"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1968, 1215]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1998 — join's elemToStr handles only f64/i32 elements

## Problem

All of these trap `RuntimeError: illegal cast` (node output in comments):

```ts
const a: any[] = [10, 9]; a.join(",")   // "10,9"
[1, undefined, 2].join("-")             // "1--2"
[1, null, 2].join("-")                  // "1--2"
Array(3).join(",")                      // ",,"
[1,,3].join(",")                        // "1,,3"
```

## Root cause

`src/codegen/array-methods.ts:4543-4556` (`compileArrayJoin` elemToStr) —
only `f64`/`i32` elements get `number_toString`; externref elements (boxed
numbers, undefined, null) flow raw into the `wasm:js-string` `concat`
builtin, which traps on any non-string. Spec §23.1.3.18 step 7.c:
undefined/null elements → "", others → ToString.

## Fix direction

For externref elements emit: null-check → "" ; else `__any_to_string`-style
host ToString before concat.

## Acceptance criteria

- All five repros match Node; numeric/string element joins unchanged

## Dupe check

#1968 covers only the empty-array `resultTmp` null init (different lines,
different symptom); #1215 (done) covered typed `number[]`. New.
