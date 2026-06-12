---
id: 1982
title: "IR: lazy use-site emission reorders memory reads past writes — slot/class-field reads observe future mutations"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
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

## Implementation notes (2026-06-12, senior-fable)

Implemented as an **emission-point resolution pass** in `src/ir/lower.ts`,
inserted between the crossBlock computation and local allocation, plus a
one-line hook in `emitBlockBody` (anchored values take the existing
crossBlock emit+`local.set` branch).

**Why not the issue's "materialize eagerly unless the use is the
immediately-next instruction" first cut:** that rule anchors every member
chain (`a.b.c.d`) and every nested call (`f(g(x))`) — both extremely common
and both safe — so the code-size criterion fails. Instead the pass resolves,
bottom-up per block, where each instr's tree is actually emitted:

- in-place instrs (void result, crossBlock, eager side-effect drop) emit at
  their own index; lazy values at their first consumer's *resolved* emission
  point (multi-use tees execute the tree once, at first use); dead pure
  values never.
- a non-pure lazy candidate anchors at its def iff some instr between def
  and emission point **executes before the candidate's tree** and
  **conflicts** with it.

Two load-bearing subtleties found during design:

1. **Same emission point ≠ safe.** Two values collapsing into the same
   consumer tree execute in tree order, which matches def order only when
   one transitively consumes the other (SSA: operand defs precede
   consumers, operands emit before their op). Unrelated siblings can swap —
   `select` emits its condition *last*, and values defined by earlier
   statements are referenced in arbitrary operand positions (`const c = g();
   const t = b.v + 1; return t + c` emits the read before the call). So
   same-point pairs are conflict-checked unless data-dependent. This is
   what keeps `f(g(x))` lazy (g flows into f) while fixing the sibling case.
2. **Slot precision matters and is free.** Slots are Wasm locals: only
   `slot.write` and loop headers (forof slot fields) touch them — a call can
   never write another function's locals (mutable captures go through
   refcells). So `slot.read` anchors only against writes of the *same*
   slot index, not against every call, which keeps anchoring (and the
   extra locals) limited to genuinely conflicting windows. Heap reads
   (class.get/object.get/vec.*/refcell.get/global.get) conservatively
   conflict with any heap write or call.

Effect summaries (`SchedFx`) recurse into loop/if/try buffers; unknown
future instr kinds default to a full barrier (exhaustiveness-checked).
Buffer-internal values were already safe: their uses are recorded against
the synthetic `-1` block, so every used buffer value is crossBlock and
materializes at def.

**Scope:** the lowerer runs only under `experimentalIR` (and linear-IR
tests) — default-path codegen is byte-identical, so test262 cannot move.

**Validation:** 4 repro variants fixed (probe + `tests/issue-1982-ir-emission-order.test.ts`,
9 cases incl. sibling call/read both operand orders, multi-use tee across
loop, disjoint-slot non-anchoring); IR suites — identical pass/fail set to
main (the 8 failures in `tests/ir/{inline-small,passes}.test.ts` and the
ir-*-equivalence env breakage pre-date this change); 600-program seeded
statement fuzz (IR vs legacy vs Node, 4 seed bases) clean — the harness
verifiably catches the bug on unfixed main (IR-only divergence at seed
198200037), after two generator fixes: block-scoped name tracking, and
box/helper moved inside `f` (module-level state body-shape-rejects the
function, silently fuzzing legacy-vs-legacy); `check:ir-fallbacks`
unchanged; 600-statement single-block compile time on par with main.
