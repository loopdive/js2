---
id: 1994
title: "reduce/reduceRight on string[] trap 'illegal cast' — accumulator local hard-coded to numeric kind"
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
related: [1967]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1994 — string accumulator coerced through numeric unbox

## Problem

```ts
const a = ["a","b","c"];
a.reduce((x: string, y: string) => x + y)
// wasm: RuntimeError: illegal cast   node: "abc"
```

Also traps with an explicit initial value (`a.reduceRight((x,y)=>x+y, "z")`).
Numeric reduce/reduceRight work.

## Root cause

`src/codegen/array-methods.ts:5429-5435` (`compileArrayReduce`, same
pattern in `compileArrayReduceRight` at ~5555) — the `accTmp` local is
always `numKind` (`i32`/`f64`) regardless of accumulator type; externref
string elements get coerced through a numeric unbox that traps.

## Fix direction

Pick `accTmp`'s ValType from the resolved accumulator/element type
(externref for strings), mirroring how map/filter handle externref
elements.

## Acceptance criteria

- Both repros match Node; numeric reduce unchanged
- reduce on string[] with and without initial value works

## Dupe check

#1967 covers struct(`ref`)-element gates returning garbage; string elements
are externref, pass that gate, and hit this distinct bug. New.
