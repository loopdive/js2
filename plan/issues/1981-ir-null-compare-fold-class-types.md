---
id: 1981
title: "IR: === null / !== null on class-typed values statically folded to false/true — null guards silently deleted"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1392, 1169, 1574]
origin: "2026-06-10 deep-audit sweep (IR agent): verified on main @ 0c753ea88, IR path"
---

# #1981 — `tryFoldNullCompare` bail-out list missing class/object/closure/vec kinds

## Problem

The defensive null-check idiom is compile-time deleted for class-typed
(WasmGC `(ref null $Struct)`) values:

```ts
class A { v: number = 7; }
export function f(p: A): number {
  if (p === null) return -1;
  return 0;              // (variant: return p.v → trap)
}
// host calls f(null)
```

`f(null)`: IR → `0` (silent wrong value); with `return p.v` →
`RuntimeError: access to a null reference`. Legacy → `-1`. Node → `-1`.

## Root cause

`tryFoldNullCompare` (`src/ir/from-ast.ts:3923-3959`) folds `expr === null` to
constant false on the slice-1 assumption "no IR type can be null". Slices 4/10
added nullable-at-Wasm-level kinds and patched the bail-out list for `boxed`,
`extern`, `val{externref|ref_null}` (3942-3957) — but **`class` was never
added** (nor `object`/`closure`/`vec`, also `ref null` carriers). A
class-typed operand falls through to `emitConst(bool)` at 3959.

## Fix direction

Minimal: bail (→ legacy fallback) for
`otherType.kind === "class" | "object" | "closure" | "vec"`. Better: emit a
runtime `ref.is_null` via the #1392 primitive (`emitRefIsNull`, already used
by `??` and optional chaining) instead of folding, for every ref-shaped kind.

## Acceptance criteria

- Repro returns `-1` for null on the IR path
- Non-nullable cases (literal receiver) may keep the fold
- `!== null` mirror covered

## Dupe check

#1392 (ref.is_null primitive — done, didn't touch the fold), #1169a (documents
the fold + boxed bail only), #1574 (class nominality note). Unfiled.
