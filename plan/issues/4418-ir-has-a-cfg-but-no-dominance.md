---
id: 4418
title: "The IR has a CFG but no dominance — GVN, LICM and SCCP are all blocked on it"
status: done
sprint: Backlog
created: 2026-08-14
updated: 2026-08-15
completed: 2026-08-15
priority: medium
horizon: l
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

## Critical review (2026-08-15, Fable lane) — two premises corrected before implementation

Reviewed against the tree at `d5ce65836` before writing any code. Both of the
issue's central claims needed correction, and the corrections change the
scope:

**1. "No dominator tree — neither term appears anywhere in src/" was false.**
`verify.ts` has carried `computeDominators()` since #1850 — a full-set
iterative dominance computation, live on every IR-function verification,
powering exactly the cross-block use-dominated-by-def check. What was true:
it was private to the verifier, O(blocks²) set-based, rebuilt on every
verification with no reuse, and exposed no tree shape, no idom, no
`dominates()` API, and no frontier.

**2. "GVN, LICM and SCCP are all blocked on it" has the dependency backwards
for THIS IR.** ADR-0018 (#1925's decision, Option A) committed to the
structured direction: loops and ifs are nested instruction buffers, NOT
blocks. `lower.ts`'s own contract is "no joins, no back-edges, no
fall-through" — the block graph the producer emits is a TREE. Consequences:

- On every graph the front-end can currently produce, the dominator tree IS
  the CFG tree (each reachable non-entry block has exactly one predecessor)
  and every dominance frontier is EMPTY. This is now asserted as a tested
  invariant rather than left implicit.
- LICM is already specced buffer-based (#1574 §3.8) and needs no dominance.
- GVN's "does the earlier computation dominate the later use" is structural
  nesting in this IR — a scoped-hash-table walk down the structure tree, no
  CHK required.
- SCCP's fold half is buffer recursion (`constant-fold` already recurses via
  `mapNestedBuffers`, #1925).
- A phi-based CFG world where frontiers matter is precisely the Option B
  that ADR-0018 rejected. Reviving it is an ADR revision — a deliberate
  architectural decision, not something to smuggle in under "add dominance".

**What survives as real work:** extract, upgrade and share the analysis the
verifier already depends on; harden it against general graphs (verified by a
naive reference) so it cannot silently rot if a future producer — or an
ADR-0018 revision — starts emitting joins; and re-point the optimisation
follow-ups at the structured substrate where they actually live.

## Refined plan + what landed (same day)

**Landed in the impl PR (this slice):**

1. `src/ir/analysis/dominance.ts` — Cooper–Harvey–Kennedy iterative idoms on
   flat arrays (replacing the O(n²) full-set fixpoint), dominator tree,
   O(1) reflexive `dominates()` via tree pre/post numbering, deduped
   reachable-only predecessor lists, reverse postorder, dominance frontiers
   (definition-exact, including the degenerate edge-into-entry shape the
   textbook runner loop misses), and `rawPredecessorCounts` (the multiset
   simplify-cfg's merge rule is defined over — a different query, kept
   distinct on purpose).
2. **Caching = identity.** The IR is functional — passes return new
   `IrFunction` objects — so a `WeakMap<IrFunction, DominanceInfo>` is the
   whole invalidation story. The original AC's "invalidated whenever a pass
   mutates the block list" presumed mutation that does not exist here.
3. **verify.ts consumes it** (first consumer, zero behaviour change): same
   #1850 check, now shared + cached + linear-ish. The one behavioural
   subtlety carried over explicitly: an unreachable use-block never violates
   dominance (the old full-set init answered "dominated" there).
4. **simplify-cfg consumes `rawPredecessorCounts`** (AC met, semantics
   preserved: raw multi-edge count over all blocks, so a both-arms `br_if`
   still counts two edges).
5. **Naive reference + cross-check** (`computeDominanceNaive`,
   `crossCheckDominance`): unit tests run it on synthetic general graphs —
   diamond join, back-edge loop, nested loops, self-loop, irreducible
   double-entry cycle, unreachable blocks, both-arms br_if, edge-into-entry —
   and `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE=1` audits it corpus-wide through
   the verifier (quadratic; run deliberately, not in CI).
6. Tests assert the **ADR-0018 producer invariant** (join-free ⇒ dom tree ==
   CFG tree, all frontiers empty) so any future join-emitting change to the
   producer flips a test the moment the invariant stops holding.

**Deliberately NOT in this slice, filed as the honest follow-up shape:**

- Structure-tree GVN (the real optimisation lever under ADR-0018) — needs
  its own issue; the "measured emitted-code improvement" AC belongs THERE,
  not on this infrastructure slice. Wrong to gate shared-analysis extraction
  on an optimisation whose substrate is the structure tree, not this CFG.
- Buffer-based LICM per #1574 §3.8 (already specced).
- Any Option-B / phi-CFG revisit — requires an ADR-0018 revision first.

## Acceptance criteria (revised to match the corrected premises)

- [x] Dominator tree computed per `IrFunction`, identity-cached (WeakMap);
      functional-IR identity IS the invalidation discipline.
- [x] Naive-reference verifier agrees across synthetic general graphs and,
      behind `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE=1`, across every function the
      IR test corpus compiles (audited clean once; timeouts under the
      quadratic audit are the audit's cost, not disagreements).
- [x] `simplify-cfg` re-expressed on the shared predecessor helper.
- [x] verify.ts's #1850 check re-expressed on the shared analysis with
      byte-identical verdict behaviour (unreachable-use conservatism kept).
- [ ] ~~A dominance-dependent pass with measured emitted-code improvement~~ —
      re-pointed to the structure-substrate follow-ups above, where the
      optimisations actually live under ADR-0018.

Repro/tests: `tests/ir-dominance.test.ts` (13 unit tests — synthetic general
graphs cross-checked against the naive reference, plus the ADR-0018 producer
invariant).
