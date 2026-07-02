---
id: 2990
title: "IR effects slice 3: derive the DCE facet from the effects table, resolve the extern.regex divergence, offer facets to capability/selector"
status: ready
sprint: Backlog
created: 2026-07-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: correctness
parent: 2134
related: [2134, 2135, 1982]
origin: "#2134 slice-3 follow-up (design doc in plan/issues/2134-ir-effect-model-ordered-emission.md)"
---

# #2990 — finish unifying the IR effect model (#2134 slice 3)

#2134 slices 1+2 landed `src/ir/effects.ts` (the scheduler's exhaustive
`effectsOf` table + the DCE `isSideEffecting` facet moved beside it, plus the
independent `verifyEmissionSchedule` tripwire). Deliberately left for this
follow-up, each needing its own equivalence proof (NOT byte-identity — these
change behavior):

## 1. Derive `isSideEffecting` from the table

Today it is a verbatim-moved hand list. The honest derivation is roughly
`writesHeap || control || allSlots || writeSlots.size > 0` plus documented
policy quirks that must each be either preserved-with-rationale or fixed:

- `slot.read` is always-keep ("avoid breaking the for-of body's load/use
  pattern") — a scheduling artifact, not an effect; check whether it is
  still needed post-#1982.
- `iter.done` / `iter.value` are NOT DCE-pinned but ARE full barriers in
  the scheduler — probably correct (reads of iterator state), verify.
- A dead `object.get` / `class.get` / `vec.get` whose read could TRAP
  (null deref, OOB) IS droppable today — dropping erases an observable
  throw. Decide policy (JS semantics says keep; perf says drop) and encode
  it once.

## 2. Resolve the `extern.regex` divergence

DCE-kept (RegExp_new may throw on bad pattern syntax) but scheduler-PURE —
the scheduler may today reorder a regex literal across effectful ops,
moving its potential throw. Classify it `control: true` (or heap-read) in
`effectsOf` and prove the emission delta on regex-using corpora is
behavior-equivalent (the tripwire test in `tests/issue-2134.test.ts` pins
the current divergence and must be updated by this change).

## 3. Offer effect facets to #2135 capability / selector consumers

dev-2138f (capability.ts) ACKed the composition direction: capability rows
may consult effect facets (e.g. "claim only if the lowering's instrs are
effect-classifiable"). Design with them; keep `effects.ts` a dependency-free
leaf (consumers import it, never the reverse).

## Acceptance

- `isSideEffecting` computed from `effectsOf` + an explicit, documented
  quirk table; a new IrInstr kind gets its DCE polarity from the table
  (safe default: kept) instead of the old silent-droppable default.
- `extern.regex` reorder hazard closed with an equivalence-proven
  classification change.
- No test262 regression; equivalence suite green; the #2134 tripwire test
  updated to assert consistency with zero exemptions.
