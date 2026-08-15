---
id: 4424
title: "Structure-tree GVN — scoped value numbering over the ADR-0018 nested-buffer IR"
status: ready
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
