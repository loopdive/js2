---
id: 2120
renumbered_from: 1953
title: "captured let loop variable also mutated in the loop body produces an invalid module (F64Add type mismatch)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: closures
goal: compilable
related: [1589, 1617, 1453]
origin: "2026-06-10 deep-audit sweep (closures agent): verified on main"
---

# #2120 — loop pre-box pass inconsistent when the loop var is captured AND body-written

## Problem

```ts
export function test(): number {
  let f: () => number = () => -1;
  for (let i = 0; i < 4; i++) {
    f = () => i;
    i += 1;        // body mutation of the captured loop var
  }
  return f();
}
```

wasm: `WebAssembly.Module doesn't validate: F64Add left value type mismatch,
in function at index 0` — node: `3`.

Control: identical loop **without** the body mutation validates and runs.
Also reproduces with `fns.push(() => i); i += 1`.

## Root cause (area)

The #1589/#1617 loop pre-box pass in `src/codegen/statements/loops.ts`
(`findAllNamesCapturedByClosuresInForLoop` → pre-box into ref-cells at loop
head). When the loop variable is captured *and* additionally written in the
body, one access site (the `i += 1` compound assignment or the for-increment)
is compiled against the unboxed f64 view while the other operand comes from
the boxed ref-cell slot, leaving a non-f64 on the stack for `f64.add`. #1617
fixed the body-local-`const` over-boxing variant; this loop-var+body-write
shape is a remaining hole.

## Fix direction

Make all read/write sites of a pre-boxed loop variable consistently go through
the ref-cell (compound-assignment and for-increment paths included), or
exclude this shape from pre-boxing and box at closure creation as for ordinary
captures. Coordinate with #1453 (per-iteration let bindings, in-review) which
rewrites the same allocation strategy.

## Acceptance criteria

- Repro validates and returns Node's value (`3`)
- `fns.push(() => i); i += 1` variant compiles and runs
- #1617's fixed shapes stay fixed

## Dupe check

Grepped `F64Add`, `boxed.*loop`, `capture.*loop`: #1617 (done — sibling
shape), #1589 (pre-box origin), #1453 (in-review — per-iteration *values*,
not this validation failure). Untracked.

## Resolution (2026-06-11)

Fixed in `src/codegen/expressions/assignment.ts`. The boxed (ref-cell) compound-
assignment path reads the captured loop var from the cell, then the op switch
emits **f64 arithmetic** (`f64.add`, `f64.sub`, …). For an **i32** ref-cell the
read produced i32 but `f64.add` consumed it → `F64Add left value type mismatch`,
an invalid module. The guard `boxedNeedsCoerce` previously excluded i32 from the
"promote to f64 before the op, coerce back on writeback" path. Widening it to
`boxed.valType.kind !== "f64"` (i.e. include i32) makes the cell value and RHS
both f64 before the arithmetic and coerces the result back to i32 on writeback.
The i32↔f64 round-trip is exact for the loop-counter range, and the f64-cell
path is unchanged.

### Test Results

`tests/issue-2120.test.ts` (4 cases, all PASS, all validate):

| case | result |
|------|--------|
| `for (let i…) { f = () => i; i += 1 }` (the repro) | 3 ✓ |
| descending `i -= 1` capture | 1 ✓ |
| captured f64 loop var compound-assign (unregressed) | 3.0 ✓ |
| captured-not-body-written control | 3 ✓ |

`tsc --noEmit` clean; sibling `tests/issue-1589a.test.ts` + `tests/issue-1453.test.ts`
green, and `tests/issue-1617.test.ts` is unchanged from baseline (its one
pre-existing `renderCal` failure fails identically with this change reverted).

### Known residual (separate bug, follow-up)

The `fns.push(() => i); i += 1` acceptance variant now **validates** (was an
invalid module on main) but hits a runtime null-deref from a *separate*
per-iteration-cell allocation bug in the array-push + closure-capture
interaction — the same allocation strategy #1453 (in-review) rewrites. The
F64Add invalid-module root cause named in this issue is resolved; the push
runtime residual is tracked for the #1453 cell-allocation rework.
