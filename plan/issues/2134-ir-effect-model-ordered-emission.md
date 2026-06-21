---
id: 2134
title: "IR effect model: classify instruction kinds, enforce program-order emission for effectful ops"
status: blocked
blocked_by: [2167]
sprint: 65
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1924, 1982, 1925]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N1)"
---

# #2134 — the IR scheduler has no purity contract; #1982 will recur

## Problem

`emitBlockBody`/`emitValue` (`src/ir/lower.ts:2131-2160`, `:686-710`) defer
single-use defs to their use site and re-emit def trees, treating
`struct.get`/`slot.read` as freely movable pure values. #1982 (lazy emission
reorders memory reads past writes — silent wrong arithmetic, WAT-proofed) is
the symptom; its fix (PR #1405) is point-wise. The IR still has no
`pure / read / write / control` classification on instruction kinds and no
verifier rule that effectful ops keep program order. Every new instruction
kind re-rolls the dice.

## Approach

1. One `effects` table per `IrInstr` kind (share with
   `dead-code.ts isSideEffecting`, which already half-exists).
2. `emitBlockBody` defers only `pure` instructions.
3. Verifier rule (under #1924's table-driven framework): assert the table
   covers every kind (exhaustive switch) and that emitted order preserves
   read/write ordering.

## Acceptance criteria

- #1982 repros A+B pass (regression-guarded).
- A unit test injecting a deferred `class.get` past a `class.set` fails
  verification.
- No byte-diff on the playground corpus for pure-only functions.

## Notes

Fable-routed: the effects-table design review is the hard part. Sequence
with #1924 (the verifier framework it plugs into).
