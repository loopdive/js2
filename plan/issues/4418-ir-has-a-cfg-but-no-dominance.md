---
id: 4418
title: "The IR has a CFG but no dominance — GVN, LICM and SCCP are all blocked on it"
status: ready
sprint: Backlog
created: 2026-08-14
updated: 2026-08-14
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir
goal: performance
---

## What exists

The IR already has a real control-flow graph, in a good modern shape:

```ts
export interface IrFunction {
  /** Entry block is always `blocks[0]`. */
  readonly blocks: readonly IrBlock[];
}
export interface IrBlock {
  readonly id: IrBlockId;
  /** SSA values bound on entry (replace phi nodes). */
  readonly blockArgs: readonly IrValueId[];
  readonly blockArgTypes: readonly IrType[];
  readonly instrs: readonly IrInstr[];
  readonly terminator: IrTerminator;
}
```

That is **SSA with block arguments** rather than phi nodes — the MLIR / Swift
SIL design, generally the easier of the two to maintain. `src/ir/lower.ts`
reconstructs structured Wasm control flow back out of it, and
`src/ir/passes/simplify-cfg.ts` merges trivially-linked blocks to fixpoint
alongside constant-fold and DCE.

## What is missing

**No dominator tree and no dominance frontier.** Neither term appears anywhere
in `src/`. `simplify-cfg.ts` mentions predecessors three times; it is a local
peephole on the graph (merge A→B when B has exactly one predecessor), not an
analysis framework. Parts of the front-end deliberately route around the graph
entirely — `src/ir/from-ast.ts:8864` reads *"no CFG access, so this stays fully
structured"*.

So the data structure is there but not the fact that unlocks optimisation:
**does A definitely execute before B on every path?** Almost every classical
optimisation reduces to that question, and none of them can be written safely
without it:

| optimisation | needs dominance for |
| --- | --- |
| GVN (global value numbering) | "I already computed this expression; reuse it" — only sound if the earlier computation dominates the later use |
| LICM (loop-invariant code motion) | hoisting a computation out of a loop, which requires the preheader to dominate every use |
| SCCP (sparse conditional constant propagation) | proving a branch is never taken, then deleting it and everything it dominates |

## Why it matters here

This is a **quality-of-output** axis, distinct from the compile-speed work in
#4415/#4416. The compiler currently emits code without any of these passes, so
loop-heavy and expression-heavy input carries redundancy the backend never
removes. It also composes with `backend-agnostic-ir` and `ir-full-coverage`
(see `plan/goals/goal-graph.md`): every consumer of the IR benefits once, and
the linear / WasmGC / bytecode backends all inherit it.

## Shape of the work

1. **Dominator tree.** Cooper–Harvey–Kennedy iterative dominance is the
   pragmatic choice — a few hundred lines, simple enough to verify by
   inspection, and fast in practice on the block counts we produce.
   Lengauer–Tarjan is asymptotically better and much harder to get right;
   there is no evidence yet that we need it.
2. **Dominance frontier**, derived from the tree — needed if phi/block-arg
   placement is ever recomputed, and by SCCP.
3. **A verifier**, because a wrong dominator tree produces miscompiles that are
   extremely hard to trace. `src/ir/verify.ts` is the natural home. Cross-check
   the fast algorithm against a naive O(n²) reachability definition on every
   IR function in the test corpus, behind a debug flag.
4. **One consumer, to prove the machinery** — LICM is the usual first choice
   because the win is legible and the safety condition is narrow.

## Acceptance criteria

- [ ] A dominator tree is computed per `IrFunction` and cached on the pass
      pipeline, invalidated whenever a pass mutates the block list.
- [ ] A naive-reference verifier agrees with it across the whole test corpus.
- [ ] `simplify-cfg` is re-expressed in terms of the shared predecessor map
      rather than recomputing its own.
- [ ] At least one dominance-dependent pass lands with a measured
      emitted-code improvement (bytes and/or a benchmark), not just "it runs".

## Notes

Sizing this `xl` deliberately. The tree itself is a contained piece of work;
the cost is in the verifier, the invalidation discipline across the existing
pass pipeline, and the first consumer. Splitting it — tree + verifier first,
consumers as separate issues — is probably right once someone picks it up.
