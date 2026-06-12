---
id: 2112
renumbered_from: 1953
title: "captured let loop variable also mutated in the loop body produces an invalid module (F64Add type mismatch)"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
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

# #2112 — loop pre-box pass inconsistent when the loop var is captured AND body-written

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

## Closed as duplicate (2026-06-12)

Duplicate of #2120 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2120.
