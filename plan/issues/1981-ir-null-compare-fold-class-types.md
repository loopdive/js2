---
id: 1981
title: "IR: === null / !== null on class-typed values statically folded to false/true — null guards silently deleted"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
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

## Resolution (2026-06-12)

Took the minimal fix from the fix direction: extended `tryFoldNullCompare`'s
bail-out list (`src/ir/from-ast.ts`) to cover the nullable WasmGC ref-shaped
IrType kinds `class`, `object`, and `closure`. When the non-null operand has
one of these kinds the fold returns `null`, so the caller falls through to the
standard lowering, which (for a `NullKeyword` operand) throws and triggers the
whole-function legacy fallback — and legacy emits the runtime `ref.is_null`
check on the receiver. This is exactly the pattern the existing `boxed` and
`extern` bails already use.

Note: the issue title lists `vec` too, but `vec` is not a distinct `IrType`
kind (vecs surface as `object`/`class` shapes or `val{ref_null}`, all already
covered by this bail or the pre-existing `ref_null` bail), so no `vec` branch
is needed.

## Test Results

`tests/issue-1981.test.ts` — 4/4 pass (`assertEquivalent`, wasm vs Node):
- `class === null` guard fires when the arg is `null` (was: folded to false →
  returned 0; now: returns -1).
- `class !== null` guard protects a field access when `null` (was:
  `RuntimeError: dereferencing a null pointer`; now: returns -1).
- loose `== null` guard fires when `null`.
- non-null class receiver still reads the field (no spurious guard).

Pre-existing, unrelated failures confirmed identical on clean `origin/main`:
`tests/null-deref-class.test.ts` (4/17) and `tests/null-dereference-guards.test.ts`
(2 SpreadElement-IIFE cases) fail on main too — neither touched by this change.
Several null/equality suites (`null-narrowing`, `coalesce-operator`,
`equality-mixed-types`, `strict-equality-edge-cases`, `optional-chaining-call`)
fail at import on main (broken `./helpers.js` import) — pre-existing.

IR fallback budget gate (`check:ir-fallbacks`): OK, no unintended increases.
`biome lint`, `tsc --noEmit`, `prettier --check`: all clean.
