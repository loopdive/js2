---
id: 1982
title: "IR: lazy use-site emission reorders memory reads past writes — slot/class-field reads observe future mutations"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1850, 1844, 1858]
origin: "2026-06-10 deep-audit sweep (IR agent): verified on main @ 0c753ea88, IR path, WAT-proofed; independently found by 150-program fuzz within one seed"
---

# #1982 — the IR emitter treats order-sensitive reads as freely movable pure values

## Problem

Silent wrong arithmetic in straightforward claimed code:

**A — class field, straight-line:**
```ts
class Box { v: number = 1; }
export function f(a: number): number {
  const b = new Box();
  b.v = a;
  const t = b.v + 0;   // must read a
  b.v = b.v * 10;
  return t + b.v;      // a + 10a
}
```
`f(1)`: IR → `20` — legacy → `11` — node → `11`.

**B — slot read across a loop:**
```ts
export function f(a: number): number {
  let x0 = a;
  const x1 = x0 + 5;   // must snapshot a+5
  let i = 0;
  while (i < 2) { x0 = x0 * 10; i = i + 1; }
  return x1;
}
```
`f(1)`: IR → `105` — legacy → `6` — node → `6`. Same with `for`, and
class-field-across-loop (`200` vs `101`).

WAT proof: the `t = b.v + 0` subtree (`struct.get; f64.const 0; f64.add`) is
emitted *after both* `struct.set`s, immediately before `return`.

## Root cause

`src/ir/lower.ts` emission scheduling. `emitBlockBody` (lower.ts:2111-2145)
does not emit result-bearing instructions in program order: single-use values
are deferred entirely to their use site, multi-use values to first use via
local.tee (`emitValue`, lower.ts:676-703 → `emitInstrTree` re-emits the def
tree at the use). Only `crossBlock` values (lower.ts:409-500) are
pre-materialized at def position. Order-sensitive **reads** — `slot.read`
(lower.ts:1241-1247), `class.get`, and by the same logic
`object.get`/`vec.get`/`refcell.get`/`global.get` — are treated as freely
movable pure values, so a read defined before an intervening write/loop is
re-emitted after it. If-arms escape only because arm buffers force cross-block
materialization; def-before-loop with use-after-loop is "same block" and
unprotected. (Straight-line *slot* variants are accidentally safe today only
because bare `x = …;` ExpressionStatements are body-shape-rejected — class
field writes ARE claimable, hence repro A.)

## Fix direction

Make the scheduler effects-aware: any value whose def tree contains an
order-sensitive read (slot.read, class.get, object.get, vec.get/len,
refcell.get, global.get, extern.*) must be anchored at def position (emit +
local.set, like the crossBlock path) whenever an instruction with a
possibly-aliasing write effect (slot.write, class.set, object.set,
refcell.set, global.set, any call, or a loop/try/if containing one) occurs
between def and use in the same block. Conservative first cut: treat such
reads like `isSideEffecting` in `emitBlockBody` and materialize eagerly unless
the use is the immediately-next instruction. Note the IR itself is
well-ordered — this is purely an emission bug, invisible to the #1850
verifier; consider a post-lowering check that emitted order preserves IR
read/write order per memory class.

## Acceptance criteria

- Both repros (+ for-loop and class-across-loop variants) match Node
- 150-program statement fuzz (IR vs legacy vs node) clean
- No significant code-size/perf regression on the IR path (locals only where
  an intervening write exists)

## Dupe check

#1850/#1844 (verifier SSA/dominance — orthogonal, IR is valid here), #1858
(no emission-ordering item), #1945 (legacy for-of hoist — different
mechanism), #1131/#1574. Unfiled.
