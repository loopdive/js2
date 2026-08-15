---
id: 4424
title: "Structure-tree GVN — scoped value numbering over the ADR-0018 nested-buffer IR"
status: in-progress
sprint: Backlog
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir
goal: performance
related: [4418, 1574, 1925]
loc-budget-allow:
  - src/ir/integration.ts
---

# #4424 — Structure-tree GVN over the nested-buffer IR

Split out of #4418's critical review. #4418 asked for classical
dominator-tree GVN; under ADR-0018 (structured IR, #1925) "the earlier
computation dominates the later use" is **structural nesting**, not a CFG
question: an instruction in a buffer executes before everything after it in
that buffer and before everything in buffers nested under those later
instructions. So the classic dominator-tree-walk GVN becomes a **scoped
hash-table walk down the structure tree** — same algorithm, simpler substrate,
no CHK required.

## What it does

Walk each `IrFunction` top-down. Maintain a scoped table keyed by
`(opcode, operand value-ids, immediates)` → defining `IrValueId`:

- On entering a nested buffer (`if` arms, `for.loop`/`while.loop`/`forof.*`
  bodies, `try`), push a scope; pop on exit — a value computed inside an arm
  must not be reused after the join, and a value computed in a loop body must
  not leak to a sibling iteration-independent context.
- A redundant pure instruction is deleted and its uses renamed to the earlier
  value id.
- **Purity is the safety condition and must be explicit**: no calls, no
  global/field/element writes-or-reads-with-intervening-writes, no
  `raw.wasm`, nothing allocating with observable identity (`struct.new` with
  later identity comparison). Start with the provably pure arithmetic /
  compare / cast / `local`-free subset and widen with evidence — a wrong
  "pure" verdict here is a silent miscompile.
- Loop bodies: a table entry computed BEFORE the loop is reusable inside it
  (the loop body executes after), but entries created inside the body must
  die at the body's end (they rebind per iteration).

## Interaction with existing passes

- `constant-fold` (recursing via `mapNestedBuffers`, #1925) runs first — GVN
  then sees folded operands.
- #1574 §3.3 local-CSE, if built separately, is subsumed by this pass (a
  single-scope table IS local CSE); prefer building this once.
- Buffer-LICM (#1574 §3.8) runs after: hoisted computations become reusable
  table entries at the parent scope.

## Acceptance criteria

- [ ] Flag-gated (`JS2WASM_IR_GVN`, tuned-flag family, default OFF until
      measured — the #4455 pattern).
- [ ] IR verifier green pre/post on the whole corpus; equivalence gate green.
- [ ] Measured emitted-code improvement (bytes and/or acorn/benchmark wall)
      reported with the A/B discipline — this inherits #4418's original
      "measured improvement" AC.
- [ ] A poison mode (perturb reused values) proving the pass fires on the
      measured workload.

## Implementation (2026-08-15, same session as the spec)

Landed in the impl PR, flag-gated `JS2WASM_IR_GVN` (default OFF):

- **`src/ir/passes/gvn.ts`** — scoped value numbering with the classical
  dominator-tree walk on the BLOCK level (consumes #4418's `dominanceOf`, so
  it stays correct if joins ever appear) and one fresh scope per nested
  BUFFER — the single uniform rule that encodes every structural safety
  condition (if-arms can't serve siblings or the join; loop-body entries die
  at body end; try entries can't leak past a throw).
- **Fail-safe by construction**: the pass only RENAMES uses to the earlier
  id — the duplicate stays in place and `deadCode` sweeps it. A use the
  renamer can't rewrite keeps the duplicate live and correct (missed merge,
  never a miscompile). No instruction is deleted here, so the #1586
  alloc-registry rules never engage; alloc-carrying instrs are excluded from
  merging anyway (identity).
- **Admission** = `result !== null` ∧ `effectsArePure(effectsOf(instr))`
  (#2134's single source of truth — new kinds are full barriers there, so
  inert here by default) ∧ no `alloc` ∧ no nested buffers. Key = the whole
  instr JSON minus result/site/alloc (bigint-safe); over-keying is a missed
  merge, under-keying would be a miscompile, so `resultType` stays in.
- **Rename is chain-free** (a value is merge-source XOR merge-target), so
  single-step lookup is exact; global application is sound because rename
  validity follows from def-site dominance, not discovery order.
- Wired into `runHygienePasses` after constant-fold, before deadCode.
  `renameInstrOperands` exported from inline-small (exhaustive over the
  instr union) and reused.

### Verification

- `tests/ir-gvn.test.ts` — 7/7: straight-line merge; the three scope-safety
  shapes built so a scope bug is OBSERVABLE (pure merges never change the
  merged value — a wrong scope shows as reading an unmaterialized local on
  the untaken path); in-iteration and outer-into-loop reuse; and the
  **poison liveness control**: `JS2WASM_IR_GVN=poison` moves the result off
  the correct value, proving the merge fires end-to-end.
- tsc clean; IR suite + equivalence gate green with the flag off (default
  path is structurally unchanged: `afterGVN = afterCF`).

### The honest measurement — and the AC that stays open

`JS2WASM_IR_GVN=1 JS2WASM_IR_GVN_DEBUG=1` on the acorn standalone compile:

```
[ir-gvn] functions=39 merged=15 poisoned=0     (binary Δ +3 B — noise)
```

**The IR path compiles 39 of acorn's ~3,500 functions.** GVN's reach on real
workloads is bounded by IR-adoption breadth (#2855 / `plan/log/ir-adoption.md`),
not by the pass. A wall A/B at 15 merges would measure nothing; running one
anyway and quoting it would be exactly the extrapolation this project's
measurement rules forbid. The "measured emitted-code improvement" AC therefore
stays OPEN, blocked on IR coverage — revisit when the IR path carries a
meaningful fraction of a perf workload, and flip the default only then.
