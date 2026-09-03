---
id: 5282
title: "R2 fast-mode admission masks every later withdrawal reason — the 20-reason vocabulary collapses to one, and R2-E1 is blocked on it"
status: ready
created: 2026-09-03
updated: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3521, 3518, 2856]
---

## Problem

#3521 R2-T1 landed a 20-member withdrawal-reason vocabulary
(`src/ir/r2-withdrawal.ts`) so that a unit refused by the R2 admission chain
records *why*. In **fast mode that diagnostic value collapses to a single
reason**, and the collapse is structural rather than incidental.

`selectR2PreparedOwnerComponents` reads its predicates from an ordered table
and picks the first that fires:

```ts
// src/codegen/ir-prepared-free-functions.ts:1354-1366
// (#3521 R2-T1) The same ten predicates in the same order, read as a table
// so the FIRST failing one can be named. `find` short-circuits exactly like
// the `||` chain it replaces, so no predicate that used to be skipped runs.
const admissionPredicates = [
  ["fast-signature-unproven", () => input.ctx.fast && !( … )],
  ["async-declaration", () => isAsync],
  …
];
```

`fast-signature-unproven` is **entry zero**, and its guard is `ctx.fast && !(any
fast predicate admits)`. So in a fast lane every refusal answers
`fast-signature-unproven`, and `async-declaration`,
`param-signature-unstable`, `allocated-slot-mismatch` and the rest are
unreachable — not because they are wrong, but because they never run.

Measured on PR #5507 (R2-F1): **all 32 residual fast-lane rows read
`admission:fast-signature-unproven`**, both before and after that slice. It is a
property of R2-T1's table ordering, not of any later slice.

## Why it matters now

1. **R2-E1 is blocked on it.** Extern/reference-carrier certification needs to
   tell a reference-carrier refusal from any other fast-mode refusal. By reason
   alone it cannot: they are the same string. #5507's checkpoint records this
   explicitly as a consequence for R2-E1, and notes the only workarounds
   available today are reading the non-fast lanes' reasons instead, or
   re-ordering the table.
2. **It silently weakens pins.** `tests/issue-3521-r2-withdrawal-shapes.test.ts`
   pins one shape per reachable reason. #5507 had to re-point the
   `fast-signature-unproven` pin from `len(s: string): number` (which that slice
   admits) to `op(o: { a: number }): number`. The new pin is correct but weak —
   with the masking, *any* fast-mode refusal satisfies it, so it cannot
   distinguish a reference-carrier refusal from a shape refusal. #5507's own
   non-vacuity revert shows the symptom: dropping the new disjunct leaves that
   suite 8/8 green.
3. **The vocabulary is a #3518 instrument.** R2's telemetry is how the spine
   reports admission progress. A denominator that reports one reason for a whole
   lane cannot support the per-bucket ratchet #2855 is built around.

## Acceptance

- A fast-lane refusal records the reason that actually describes it. Whether
  that is achieved by moving the fast arm later in the table, by splitting it
  into per-family reasons, or by recording a secondary reason alongside it, is
  the implementer's call — but the choice must be justified against
  order-preservation: R2-T1's comment states `find` short-circuits *exactly*
  like the `||` chain it replaced, so re-ordering changes which predicates run
  and is **not** free. Prove admission decisions are unchanged (the set of
  prepared units must be byte-identical); only the recorded reason may move.
- `tests/issue-3521-r2-withdrawal-shapes.test.ts` gets a fast-lane shape per
  newly-reachable reason, and the `fast-signature-unproven` pin is re-pointed at
  a shape only *it* can explain.
- The non-vacuity revert that #5507 recorded as passing (drop the F1 disjunct →
  shapes suite still 8/8) must **fail** afterwards, or the pins are still blind.

## Provenance

Found while reviewing PR #5507 on 2026-09-03 and verified directly against
`ir-prepared-free-functions.ts:1354-1366` rather than taken from the lane's
report. The R2-F1 lane discovered it independently, recorded it as a
contradiction of its own plan's P2 expectation, and correctly declined to fix it
in that slice — re-ordering R2-T1's table is R2-T1's contract, not R2-F1's. This
issue exists so the finding is not lost in a merged PR's checkpoint note.
