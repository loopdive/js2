---
id: 4494
title: "IR: claim-widening breaks prepared-component partitioning — restore selector-claim ⇔ PREPARABILITY parity"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: ttraenkler/opus-4494
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
related: [4459, 4461, 4462, 3522, 3520]
origin: "2026-08-15 IR-migration session — #4589 (value-discarding statements claim) regressed a 3522 compile-once test; two more lanes hit the same shape the same day"
# The parity check IS the ownership fixpoint in `selectR2PreparedOwnerComponents`
# — one extra disjunct in the existing `crossesOwnership` predicate. It cannot
# move to a subsystem module without exporting that predicate's whole candidate
# set. The file sat exactly ON its 1671-line budget, so the 3 functional lines
# plus the comment explaining why the edge is one-directional trip the gate no
# matter how tersely they are worded.
loc-budget-allow:
  - src/codegen/ir-prepared-free-functions.ts
---

## Problem

The IR selector enforces **claim ⇔ lowering** parity per unit: a claimed unit
always produces a lowerable body. It does **not** enforce **claim ⇔
preparability** parity per **component**. A unit may be claimed, lower fine, and
then be unable to participate in any sealable prepared component — at which
point `sealDependencyCompletePreparedComponents` peels it and reports
`late-preparation-unsupported` on the metered `irPostClaimErrors` channel.

Every widening of the claim surface (as #4459 did, and as every future adoption
will) grows prepared components until they touch a non-candidate terminal or an
unresolvable ABI binding, and the whole prepared owner degrades.

## Three independent manifestations (same day, three lanes)

### 1. The #4589 regression — the trigger (bisected by dev-3522c)

`tests/issue-3522-ir-class-compile-once.test.ts >
"keeps constructor receiver calls on the virtual-dispatch direct path"` (gc +
standalone) passes at `f2058918`/#4582 and fails at `6df0fec6`/#4589.

The DIRECT control emits `irPostClaimErrors`:

```
prepared owner …:top-level-function:0 has incomplete dependencies:
  foreign-source-unit: unit-bound symbolic reference …:class-constructor:0
    belongs to non-candidate terminal …;
  unplanned-abi-binding: symbolic dependency class|…:layout:0 has no
    resolvable Program ABI binding; (×2)
```

### 2. #4462's dry-run finding

Making `algorithms.ts::main` a claim candidate co-prepared it with `fibMemo`
into one component; sealing the larger component failed
(`resolve/late-preparation-unsupported`, `source-global-outside-component`,
`foreign-source-unit`). `fibMemo` emitted alone but was not co-prepared.

### 3. #4461's documented residual

Any caller pulling a module-binding reader into its prepared component fails
preparation for **every** binding kind (the f64 control reproduces on the old
base).

## Root cause (manifestation 1, measured)

The bounded prepared population is closed by an ownership fixpoint in
`selectR2PreparedOwnerComponents` (`src/codegen/ir-prepared-free-functions.ts`).
Its comment already states the parity intent:

> Close free functions and class members together. A class-to-free edge is safe
> only when both endpoints survive the same bidirectional ownership fixed point.

The edge set that fixpoint consumes — `collectLocalCallEdgesByIdentity`
(`src/codegen/ir-first-gate.ts`) — records **only** `CallExpression` with an
identifier callee resolving to a top-level function declaration. It models **no
construction edge**.

But `derivePreparedComponentDependencies` **does** record one: a `class.new`
routes through `recordClassConstructorInitReference` →
`recordUnitReference(shape.constructorInitTarget)`, deliberately, so that
"sealing unions a constructing caller with every constructor body it executes".

So for

```ts
class A { constructor() { this.tag(); } tag(): void { observed = 1; } }
class B extends A { constructor() { super(); } tag(): void { observed = 2; } }
export function run(): number { new B(); return observed; }
```

`A`'s constructor calls `this.tag()` — virtual dispatch on a receiver — so
`constructorHasIrSafeReceiverSemantics` rejects it, and
`selectPreparedClassMemberUnitIds` therefore excludes the **whole A/B hierarchy**
from the prepared class-member population. Measured candidate set for the
sealing transaction: `{run, <module-init>}` — no class members at all.

Before #4589, `run`'s `new B();` was a value-discarding expression statement, so
`run` was rejected at select and the gap stayed latent. #4589 made that statement
claimable, `run` entered the prepared population, its `class.new` edge demanded
`B`'s constructor unit, that unit was never a candidate, and the owner degraded
after the claim.

The selector rejection of the class hierarchy was never propagated back to the
free function that constructs it — claim ⇔ preparability held per unit, not per
component.

## Fix — per-unit demotion via the existing ownership fixpoint

Chosen mechanism: **per-unit demotion, not component partitioning**. The
constructing owner withdraws *before it can claim*; existing owners keep
compile-once and nothing that already prepares is weakened.

1. `collectLocalCallEdgesByIdentity` gains `constructionCallees`: `new C()`
   contributes an edge from the enclosing owner to every **explicit** constructor
   unit in `C`'s local `extends` ancestry. Implicit constructors are excluded —
   their `_init` is an AST-free support body that
   `recordImplicitConstructorSupportReference` seals without requiring candidacy.
2. `selectR2PreparedOwnerComponents`'s fixpoint consumes that edge in **one
   direction only**: a constructing owner needs its constructor targets
   co-prepared; a constructor does **not** need its constructing callers
   co-prepared (they reach it through the sealed `<Class>_new` support wrapper).
   Folding the edge into `callees` would also feed the reverse `callers` closure
   and withdraw constructors that prepare fine today.

The change can only ever *narrow* the prepared population, and it narrows it
exactly to the owners that provably cannot seal.

## Test Results

| Manifestation | Before | After |
| --- | --- | --- |
| 1 — 3522 virtual-dispatch direct path (gc + standalone) | `irPostClaimErrors` carried one `build` entry for `run`; `run` `ir: false` | `irPostClaimErrors: []`; `run` now emits an IR body through the post-direct overlay (`ir: true`) — a coverage **gain** |
| 2 — #4462 `algorithms.ts` standalone composition | `fibMemo` emitted, `main` not co-prepared | re-measured via `check:ir-only` standalone lane (see below) |
| 3 — #4461 module-binding reader residual | — | not addressed by this slice (different failure code); bucket unchanged |

Manifestation 1 is the acceptance gate and is pinned by
`tests/issue-4494.test.ts`.
