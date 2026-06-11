---
id: 2001
title: "sparse arrays: holes materialize as element-type defaults and HOFs visit them — [1,,3].forEach runs 3×, b[5]=9 join shows zeros"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1359, 1024, 2000]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #2001 — dense WasmGC vec representation has no hole concept

## Problem

```ts
const a: any[] = [1, , 3]; let c = 0; a.forEach(() => c++); c
// wasm: 3   node: 2
const b: any[] = [1]; b[5] = 9; b.join(",")
// wasm: "1,0,0,0,0,9"   node: "1,,,,,9"
```

## Root cause

Dense WasmGC vec representation — `array.new_default` fills holes with
element-type defaults; `src/codegen/array-methods.ts` HOF loops (e.g.
`compileArrayForEach` ~5721) never perform the spec's `HasProperty(O, k)`
hole skip (§23.1.3.15 step 7.b). #1359 (done) explicitly listed this as
gap 4 but closed without fixing it.

## Fix direction

Needs a representation decision (hole sentinel vs side bitmap vs accepting
divergence for typed arrays and fixing only `any[]`). Architect input
recommended before dev dispatch; intersects #1852 per-backend value
representation.

## Acceptance criteria

- forEach/map skip holes on `any[]`; join renders holes as ""
- Documented decision for typed `number[]` (where TS semantics make holes
  unrepresentable anyway)

## Dupe check

#1359 residual (explicitly unfixed gap 4); #1024 covers holes in
destructuring only. Refiled as residual.

## Addendum (2026-06-11 iterators-agent sweep)

Same representation family, different trigger: array destructuring past
the source length on numeric element types binds the typed default
instead of undefined — `const [p, q] = [1]` → `q` stringifies "0"
(node: "undefined"); `const [a=5, b=6] = [undefined, null]` → `b` →
"0" (node: "null" — default correctly NOT applied to null, but the
null is then erased). `emitBoundsCheckedArrayGetUndef`
(`src/codegen/destructuring-params.ts:141-190`) only yields JS
undefined for externref element types. Fold into the same
representation decision as the hole semantics above (#1852/#1931).
