---
id: 1678
title: "externref-typed default value of array/rest binding param not materialised to native array (Array.isArray false) (~dominant share of #779a 727)"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring-defaults
goal: property-model
sprint: Backlog
parent: 779
es_edition: ES2017
---
# #1678 — externref default-value of array/rest binding param not materialised to native array

## Problem

When an array/rest binding-pattern parameter has a **default value whose static
type is `any` (externref)**, the bound result is an externref that
`Array.isArray` rejects — it is not wrapped as a native vec/array. The static
type of the **default value** (not the binding shape) decides the outcome.

Isolated repro (verified on main, 2026-05-27):

```ts
// FAILS (ret=2): default value typed `any` (externref)
let values: any; values = [1, 2, 3];
class C { static method([...x] = values) { /* Array.isArray(x) === false */ } }

// PASSES (ret=1): default value typed number[] (vec struct)
var values = [1, 2, 3];   // inferred number[]
class C { static method([...x] = values) { /* Array.isArray(x) === true */ } }
```

## Why this matters

This is the **dominant share** of the ~727 `class/dstr` `assertion_fail`
failures originally bucketed under #779a. The test262 harness declares
`let values: any;` then assigns `values = [1,2,3]`, so every `*-dflt-*` test
(`meth-dflt-*`, `gen-meth-dflt-*`, `async-gen-meth-dflt-*`, `private-*-dflt-*`,
…) takes the failing branch. The first failing assertion is
`assert(Array.isArray(x))`.

This is **independent of and larger than** the nested-class global-index-drift
sub-bug fixed in #779a (PR #678). That fix resolved the documented invalid-Wasm
repro; this issue covers the remaining behavioural failures.

## Root cause

The array/rest binding-default lowering does not convert an externref default
value to a native array (vec struct). When the default value is externref, the
binding receives the raw externref; `Array.isArray`, `.length`, and indexed
access then behave as for an opaque host value, not a native array.

## Fix direction

In the array/rest binding-default lowering (destructuring-params path): when the
default value is externref-typed, materialise/convert it to a native array (vec
struct) before binding — so `Array.isArray`, `.length`, and index access work.
Mirror whatever conversion the `number[]`-typed path already produces.

## Acceptance criteria

- [ ] `[...x] = values` (and `[a, b] = values`) with an `any`-typed `values`
      binds a native array such that `Array.isArray(x) === true`.
- [ ] The dominant `class/dstr` `*-dflt-*` test262 buckets flip to `pass`.
- [ ] No regression in `number[]`-typed default paths or in already-passing
      `class/dstr` tests.

## Spec reference

- ECMAScript §8.6.3 IteratorBindingInitialization (binding-element default)
- §23.1.3.2 Array.isArray

## Notes

- Split out of #779a (parent #779). See #779a "Sharper root cause of the
  residual" section for the isolation work that produced this issue.
- Related families: #820, #1130, #1633 (iterator-protocol / array-identity).
