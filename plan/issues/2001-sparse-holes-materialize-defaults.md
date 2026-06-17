---
id: 2001
title: "sparse arrays: holes materialize as element-type defaults and HOFs visit them — [1,,3].forEach runs 3×, b[5]=9 join shows zeros"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
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

## Re-validation (2026-06-17, dev-1, against origin/main @330b3cb66)

RE-VALIDATED per the s63 verify-still-repros-first discipline. The repro is
**still live** — all four documented cases reproduce on current main
(sprint-62 value-rep work did NOT fix it):

| Case | wasm (got) | node (exp) |
|---|---|---|
| `[1,,3].forEach(()=>c++)` count | `3` | `2` |
| `b=[1]; b[5]=9; b.join(",")` | `"1,0,0,0,0,9"` | `"1,,,,,9"` |
| `const [p,q]=[1]; String(q)` | `"0"` | `"undefined"` |
| `const [a=5,b=6]=[undefined,null]; String(b)` | `"0"` | `"null"` |

**Disposition: NOT a developer point-fix despite the task framing.** The
issue's "Fix direction" gates this behind a representation decision (hole
sentinel vs side bitmap vs accept-divergence for typed arrays) and states
"Architect input recommended before dev dispatch; intersects #1852
per-backend value representation." That gate is unmet, blast radius is the
whole dense-WasmGC-vec representation (every array program), and
feasibility is `hard` / reasoning_effort `high`. Routing back to
architect for the representation ratification (as #2001/#1852/#1931) before
any dev implementation — dev-1 is moving to standalone-priority work per
tech-lead direction.
