---
id: 4514
title: "R2 prepared-owner call closure: directional awareness / component splitting to restore compile-once for ABI-certified callees of withdrawn callers"
status: ready
sprint: current
created: 2026-08-16
priority: high
horizon: m
feasibility: hard
model: opus
reasoning_effort: high
task_type: enhancement
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
lane: ir-retirement
parent: 3518
related: [4508, 4494, 3521, 3518]
origin: "tech-lead dispatch 2026-08-16, from the #4508 baseline notes"
files:
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/ir-legacy-caller-abi.ts
  - scripts/ir-only-baseline.json
  - tests/issue-4508.test.ts
---

# #4514 — restore compile-once for the four units #4508's storage edge dragged out

## Problem (measured, recorded in `scripts/ir-only-baseline.json` standalone notes)

#4508 fed module-binding storage edges into the prepared-owner fixpoint. That
recovered `algorithms.ts::fibMemo` and `::main` as IR-emitted, but as a side
effect `::fibIter`, `::binarySearch`, `::quicksort`, `::joinNums` **lost
compile-once** (they still emit IR bodies, but a legacy body is emitted first):
`main` fails to seal on its own unplanned-abi-binding providers, parity
withdraws it, and the **reverse-callers edge** in
`selectR2PreparedOwnerComponents` (`src/codegen/ir-prepared-free-functions.ts`,
the `[...(callers.get(unitId) ?? [])].some(...)` disjunct in the ownership
fixpoint, ~line 1150) then drags every callee of `main` out of the enlarged
component. `tests/issue-4508.test.ts` pins the four units' compile-twice state
so this refinement flips a test.

The baseline notes explicitly rule out the two cheap outs:

- **Reverting the storage edge is wrong** — it re-loses `fibMemo`/`main`.
- **A forward-only second closure was measured and is UNSOUND** — it leaves a
  direct reader beside a still-prepared component whose late-discovered runtime
  providers break the frozen prepared ABI (`callable provider … discovered
  after prepared provider planning`).

## Implementation plan (tech lead, 2026-08-16)

1. **Instrument first.** Log which disjunct withdraws each unit in the fixpoint
   (caller-edge vs callee-edge vs construction vs storage). Confirm on current
   main that the four units are withdrawn **only** by the reverse-callers edge
   (their callee/storage edges are clean). If any unit has a second blocking
   edge, record it here and descope that unit.
2. **Directional refinement.** A unit admitted to `freeFunctionCandidates`
   already passed `r2StableSignatureType` on every param + return AND
   `r2SignatureMatchesAllocatedSlot` — i.e. its prepared ABI provably equals
   the slot ABI a legacy caller's pre-emitted `call` targets. For such a unit,
   a withdrawn/legacy **caller** is not a signature hazard (this is the same
   proof shape as `hasFullyAnnotatedScalarAbi` in
   `src/codegen/ir-legacy-caller-abi.ts`, already shipped for the select-stage
   closure — see #3518's 2026-08-15 notes). Refine the reverse-callers
   disjunct: withdraw on an outside caller **only when** the unit's ABI
   certification does not hold (e.g. reference-shaped contracts where the
   prepared component could re-plan the carrier). Keep the callee direction,
   the construction direction (#4494), and the storage direction (#4508)
   untouched — each is load-bearing for lowerability/sealing, not just
   signature safety.
3. **If step 2's blanket exemption is too coarse** (sealing still fails or the
   unsound-variant error reappears), fall back to **component splitting**:
   after the fixpoint converges, re-admit any maximal subset of withdrawn
   units that is internally closed (all callees + construction targets inside
   the subset or baseline, all storage terminals prepared) — callers outside
   the subset are permitted for ABI-certified members only.
4. **Prove soundness by the recorded failure mode**: compile the standalone
   playground corpus and assert the `callable provider … discovered after
   prepared provider planning` invariant does not fire; the shipped shape must
   not be the measured-unsound forward-only variant.

## Acceptance criteria

- [ ] `tests/issue-4508.test.ts`'s compile-twice pins for the four units flip
      to compile-once assertions (edit the test in the same PR).
- [ ] Standalone lane: `legacyBodyEmittedCeiling` ratchets 26 → ≤ 22;
      `irBodyEmittedFloor` stays ≥ 22; 0 invariants; ratchet the baseline via
      supported regeneration, not hand-editing.
- [ ] Single-host lane unchanged: 37/37 IR, READY (the caller-direction
      refinement must be structurally unreachable or provably inert there).
- [ ] `pnpm run check:ir-fallbacks` — no unintended/post-claim growth.
- [ ] Equivalence gate + standalone runtime probe (`algorithms.ts` `main()`
      runs, values unchanged vs main) green.
