---
id: 1994
title: "reduce/reduceRight on string[] trap 'illegal cast' — accumulator local hard-coded to numeric kind"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
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

## Resolution (2026-06-12)

Fixed per the fix direction in `src/codegen/array-methods.ts`. Added a
`resolveReduceAccType(setup, numKind)` helper that derives the accumulator
ValType from the callback's resolved return type (falling back to the
accumulator parameter type, then the numeric kind). Threaded the resulting
`accType` through both `compileArrayReduce` and `compileArrayReduceRight`:

- `accTmp` local is allocated as `accType` (was always `numKind`).
- The initial-value expression is compiled to `accType`.
- The no-initial-value seed element (`data[0]` / `data[length-1]`) is coerced
  `elemType → accType` before `local.set accTmp`.
- The accumulator→param0 coercion (`accCoerce`) and the callback-return→`accType`
  coercion use `accType` instead of `numKind`.
- The function returns `accType`.

The host-bridge fallback path (no `closureInfo`) keeps a numeric accumulator —
`resolveReduceAccType` returns `numKind` when there is no closure, so that path
is unchanged. Numeric reduce/reduceRight (closure with `f64`/`i32` return) also
resolve to `numKind` and are byte-for-byte unchanged.

## Test Results

`tests/issue-1994.test.ts` — 10/10 pass (`assertEquivalent`, wasm vs Node):
- reduce / reduceRight on `string[]` with and without an initial value →
  matches Node (was `RuntimeError: illegal cast` / `null`/`NaN`).
- reduce on `string[]` with 5 entries + separator → matches Node.
- mixed-type accumulator: `string[].reduce((acc:number,s)=>acc+s.length, 0)` and
  the index-parameter form → match Node.
- numeric reduce / reduceRight (no-init, with-init) → unchanged, match Node.

Pre-existing, unrelated failures confirmed identical on clean `origin/main`:
`tests/functional-array-methods.test.ts` (23/24) and `tests/array-methods.test.ts`
(22/22) fail on main too — their bespoke minimal import harness omits
`__box_number`/string constants and the test sources have a strict-typecheck
error (`number | undefined`), neither touched by this change.

Quality gate: `biome lint`, `tsc --noEmit`, and `prettier --check` all clean on
the changed files.
