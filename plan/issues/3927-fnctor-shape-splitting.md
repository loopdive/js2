---
id: 3927
title: "perf: a widened fnctor struct is the union of every shape its constructor ever takes — acorn's `Node` is 292 B for a 3-6 property object"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
language_feature: objects, classes
goal: performance
related: [4157, 3780, 3921, 3686, 3685, 743, 684]
origin: "#3780 round 4 — after packing the presence flags, `Node` is still 292 B, and the residue is the union-of-all-shapes widening itself"
---

# #3927 — per-shape splitting of widened fnctor structs

## Problem

A constructor whose instances take different property sets is lowered to ONE
closed struct carrying the **union** of every property any instance ever gets.
Acorn's `Node` is the clean example: every AST node kind — `Identifier`,
`CallExpression`, `TryStatement`, … — is the same `new Node(...)`, so the struct
carries the union of the whole ESTree surface.

Measured on the standalone acorn module (#3780 round 4):

| | fields | bytes/instance |
| --- | ---: | ---: |
| before round 4 | 130 (63 externref + 63 presence `i32` + 2 f64 + 2 ref) | 536 B |
| after round 4 (presence packed) | 69 | **292 B** |
| live properties on a typical AST node | 3–6 | — |

Round 4 removed the presence-flag half. The remaining 292 B is **62 `externref`
slots, of which a given node uses a handful.** At 32,487 nodes per 226 KB parse
that is 9.5 MB of the 43.6 MB allocated — and unlike the transient garbage in
#3921, this part is *retained* for the life of the AST, so it is paid twice:
once by the scavenger copying it, once by promotion.

## Why this is filed as hard, and what it is NOT

This is asking for the thing V8 does with hidden classes, done statically. The
honest framing:

- **A per-`type`-string split is not sound in general.** Acorn happens to set
  `node.type` before the shape settles, but nothing in the language says a
  constructor's instances partition by a string field, and the compiler cannot
  assume it.
- The tractable version is a **whole-program shape-set analysis**: collect the
  set of property sets an instance of `F` can reach, and if that set is small
  and statically separable, emit a struct per member with a common prefix
  (subtyping already supports the prefix rule — `$__vec_base` uses it). Where
  the analysis fails, keep today's union struct.
- Related prior art in-tree: #743 (whole-program type-flow analysis), #684
  (`any`-typed variable inference). This is the object-shape analogue and
  should reuse their fixpoint rather than grow a third one.

## Sequencing — do NOT start this first

Two things should land before this is worth attempting:

1. **#3921 (allocation census).** 34 MB of the 43.6 MB per parse is currently
   unattributed. If the census shows the transient 34 MB dwarfs the retained
   9.5 MB — which it does on the only measurement we have — then a cheaper
   transient-allocation fix outranks this. Do not spend an XL window on the
   9.5 MB before knowing what the 34 MB is.
2. **#3686 / #3685.** Splitting shapes makes more field accesses statically
   typed, which is the input those two want. Doing this first would mean
   re-deriving their admission logic against a moving representation.

There is also a **latent cycle guard** to fold in, recorded in
`plan/agent-context/dev-acorn-throughput.md` §6 and in #3686: `objectIrTypeFromTsType`
↔ `tsTypeToFieldIr` (`src/codegen/index.ts`) carry no seen-set, and today's code
survives only because a self-referential shape (`class Node { left: Node }`)
bails to the legacy path before it can recurse. Splitting makes those shapes
typed-and-reachable, which is exactly when the guard becomes live.

## Scope

- [ ] Whole-program shape-set analysis: per constructor, the set of reachable
      property sets, with an explicit "unknown / too many" verdict.
- [ ] Emit per-shape structs sharing a common prefix where the set is small and
      separable; keep the union struct otherwise.
- [ ] Fold in the `objectIrTypeFromTsType` ↔ `tsTypeToFieldIr` seen-set, with
      the repro that proves it — the same PR that makes the shape reachable is
      the one that can supply it.

## Acceptance criteria

- [ ] Acorn's `Node` allocation drops measurably in the `--trace-gc` per-parse
      accounting, reported alongside the census total from #3921.
- [ ] A constructor whose shapes are NOT separable still compiles, via the
      union struct, with no behaviour change.
- [ ] `for…in` / `Object.keys` / `in` answer identically before and after for
      every split shape — see #3920, which shows this surface is already
      lane-divergent and must not be made worse.
- [ ] No standalone test262 regression.
